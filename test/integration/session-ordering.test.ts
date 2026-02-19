import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'crypto'
import {
  EMULATOR_CONNECTION_STRING,
  SESSION_QUEUE,
  RESULTS_QUEUE,
  purgeQueue,
  receiveAllResults,
  type ResultMessage,
} from './helpers.js'
import { ServiceBusClient } from '@azure/service-bus'

describe('session ordering integration', () => {
  let client: ServiceBusClient

  beforeAll(async () => {
    client = new ServiceBusClient(EMULATOR_CONNECTION_STRING)
    await purgeQueue(RESULTS_QUEUE)
  })

  async function sendSessionMessage(
    sessionId: string,
    message: { testId: string; messageIndex: number; action: string; succeedAfterAttempt?: number },
  ): Promise<void> {
    const sender = client.createSender(SESSION_QUEUE)
    await sender.sendMessages({
      body: message,
      contentType: 'application/json',
      sessionId,
    })
    await sender.close()
  }

  function assertSequenceNumberPresent(results: Map<string, ResultMessage>): void {
    for (const [testId, result] of results) {
      expect(
        result.status,
        `sequenceNumber missing from trigger metadata for testId=${testId} — session ordering is inactive; check emulator setup`,
      ).not.toBe('error-no-sequence-number')
    }
  }

  it('happy path: all messages in session succeed without ordering intervention', async () => {
    const sessionId = `session-happy-${randomUUID()}`
    const testId1 = randomUUID()
    const testId2 = randomUUID()
    const testId3 = randomUUID()

    await sendSessionMessage(sessionId, { testId: testId1, messageIndex: 1, action: 'succeed' })
    await sendSessionMessage(sessionId, { testId: testId2, messageIndex: 2, action: 'succeed' })
    await sendSessionMessage(sessionId, { testId: testId3, messageIndex: 3, action: 'succeed' })

    const results = await receiveAllResults([testId1, testId2, testId3], 30_000)
    assertSequenceNumberPresent(results)

    const r1 = results.get(testId1)!
    const r2 = results.get(testId2)!
    const r3 = results.get(testId3)!

    expect(r1.status).toBe('completed')
    expect(r2.status).toBe('completed')
    expect(r3.status).toBe('completed')
    expect(r1.publishCount).toBe(1)
    expect(r2.publishCount).toBe(1)
    expect(r3.publishCount).toBe(1)
  })

  it('leader deferred: msg2 waits for msg1 retry to complete', async () => {
    // msg1 fails on attempt 1, retries (2s delay), succeeds on attempt 2.
    // msg2 arrives while msg1 is pending retry → session ordering defers msg2 to after msg1.
    const sessionId = `session-defer2-${randomUUID()}`
    const testId1 = randomUUID()
    const testId2 = randomUUID()

    await sendSessionMessage(sessionId, { testId: testId1, messageIndex: 1, action: 'fail-then-succeed', succeedAfterAttempt: 2 })
    await sendSessionMessage(sessionId, { testId: testId2, messageIndex: 2, action: 'succeed' })

    // Total wait: ~2s retry delay + 0.5s increment + processing. Allow 30s.
    const results = await receiveAllResults([testId1, testId2], 30_000)
    assertSequenceNumberPresent(results)

    const r1 = results.get(testId1)!
    const r2 = results.get(testId2)!

    expect(r1.status).toBe('completed')
    expect(r2.status).toBe('completed')

    // msg1 was retried
    expect(r1.publishCount).toBe(2)
    // msg2 was deferred by session ordering, not retried itself
    expect(r2.publishCount).toBe(1)

    // msg2 must have been processed AFTER msg1 completed
    expect(r2.processedAtMs).toBeGreaterThan(r1.processedAtMs)
  })

  it('multiple followers deferred: all three messages processed in order', async () => {
    // msg1 fails → retried. msg2 and msg3 both get deferred after msg1's retry time.
    const sessionId = `session-defer3-${randomUUID()}`
    const testId1 = randomUUID()
    const testId2 = randomUUID()
    const testId3 = randomUUID()

    await sendSessionMessage(sessionId, { testId: testId1, messageIndex: 1, action: 'fail-then-succeed', succeedAfterAttempt: 2 })
    await sendSessionMessage(sessionId, { testId: testId2, messageIndex: 2, action: 'succeed' })
    await sendSessionMessage(sessionId, { testId: testId3, messageIndex: 3, action: 'succeed' })

    const results = await receiveAllResults([testId1, testId2, testId3], 45_000)
    assertSequenceNumberPresent(results)

    const r1 = results.get(testId1)!
    const r2 = results.get(testId2)!
    const r3 = results.get(testId3)!

    expect(r1.status).toBe('completed')
    expect(r2.status).toBe('completed')
    expect(r3.status).toBe('completed')

    expect(r1.publishCount).toBe(2)
    expect(r2.publishCount).toBe(1)
    expect(r3.publishCount).toBe(1)

    // Processing order must be preserved: msg1 → msg2 → msg3
    expect(r2.processedAtMs).toBeGreaterThan(r1.processedAtMs)
    expect(r3.processedAtMs).toBeGreaterThan(r2.processedAtMs)
  })

  it('cross-session isolation: failure in session-A does not defer messages in session-B', async () => {
    // session-A: msg1 fails and retries (2s delay)
    // session-B: msg1 succeeds immediately
    // Expected: session-B processes its message without being deferred
    const sessionIdA = `session-iso-A-${randomUUID()}`
    const sessionIdB = `session-iso-B-${randomUUID()}`
    const testIdA = randomUUID()
    const testIdB = randomUUID()

    // Send both at roughly the same time so session-B can prove it's not waiting on session-A
    await sendSessionMessage(sessionIdA, { testId: testIdA, messageIndex: 1, action: 'fail-then-succeed', succeedAfterAttempt: 2 })
    await sendSessionMessage(sessionIdB, { testId: testIdB, messageIndex: 1, action: 'succeed' })

    const results = await receiveAllResults([testIdA, testIdB], 30_000)
    assertSequenceNumberPresent(results)

    const rA = results.get(testIdA)!
    const rB = results.get(testIdB)!

    expect(rA.status).toBe('completed')
    expect(rB.status).toBe('completed')

    // session-A was retried
    expect(rA.publishCount).toBe(2)
    // session-B was NOT deferred — processed on first delivery
    expect(rB.publishCount).toBe(1)

    // session-B should have completed well before session-A (which took ~2s for retry)
    // We require at least 1s margin, since session-A's retry delay is 2s
    expect(rB.processedAtMs + 1000).toBeLessThan(rA.processedAtMs)
  })
})

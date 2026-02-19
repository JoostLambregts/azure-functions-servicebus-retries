import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'crypto'
import {
  EMULATOR_CONNECTION_STRING,
  EXPIRY_QUEUE,
  RESULTS_QUEUE,
  purgeQueue,
  receiveResult,
  receiveDLQMessage,
} from './helpers.js'
import { ServiceBusClient } from '@azure/service-bus'
import { fromZonedTime } from 'date-fns-tz'


describe('preserveExpiresAt integration', () => {
  let client: ServiceBusClient

  beforeAll(async () => {
    client = new ServiceBusClient(EMULATOR_CONNECTION_STRING)
    await purgeQueue(EXPIRY_QUEUE)
    await purgeQueue(`${EXPIRY_QUEUE}/$deadletterqueue`)
    await purgeQueue(RESULTS_QUEUE)
  })

  async function sendExpiryMessage(
    message: { testId: string; action: string; succeedAfterAttempt?: number; delayMs?: number },
    timeToLiveMs?: number,
  ): Promise<void> {
    const sender = client.createSender(EXPIRY_QUEUE)
    await sender.sendMessages({
      body: message,
      contentType: 'application/json',
      timeToLive: timeToLiveMs,
    })
    await sender.close()
  }

  it('retries and succeeds within TTL: preserveExpiresAt does not break normal retry flow', async () => {
    // TTL=30s gives plenty of time; fails on attempt 1, succeeds on attempt 2 (~3s later)
    // The retry message carries the preserved (shorter) TTL matching the original
    const testId = randomUUID()
    const expectedExpiry = Date.now() + 30_000
    await sendExpiryMessage({ testId, action: 'fail-then-succeed', succeedAfterAttempt: 2 }, 30_000)

    const result = await receiveResult(testId, 30_000)
    expect(result.testId).toBe(testId)
    expect(result.publishCount).toBe(2)
    expect(fromZonedTime(result.expiry!, 'UTC').getTime()).toBeCloseTo(expectedExpiry, -2)
    expect(result.status).toBe('completed')
  })

  it('TTL shorter than delaySeconds: retry message expires before delivery, DLQ via Service Bus', async () => {
    // delaySeconds=3, TTL=2s: after the first failure the remaining TTL (~1.5s) is set as
    // timeToLive on the rescheduled message, but the message is scheduled 3s away.
    // Since remaining TTL < retry delay, the function will throw MessageExpiredError → DLQ.
    const testId = randomUUID()
    await sendExpiryMessage({ testId, action: 'fail-then-succeed', succeedAfterAttempt: 3 }, 2_000)

    const dlqMessage = await receiveDLQMessage(EXPIRY_QUEUE, 30_000)
    expect(dlqMessage).toBeDefined()
  })
})

import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'crypto'
import {
  EMULATOR_CONNECTION_STRING,
  RETRY_QUEUE,
  RESULTS_QUEUE,
  purgeQueue,
  receiveResult,
  receiveDLQMessage,
} from './helpers.js'
import { ServiceBusClient } from '@azure/service-bus'

describe('end-to-end retry integration', () => {
  let client: ServiceBusClient

  beforeAll(async () => {
    client = new ServiceBusClient(EMULATOR_CONNECTION_STRING)
    // Purge queues to start clean
    await purgeQueue(RETRY_QUEUE)
    await purgeQueue(RESULTS_QUEUE)
  })

  async function sendTestMessage(message: { testId: string, action: string, succeedAfterAttempt?: number }): Promise<void> {
    const sender = client.createSender(RETRY_QUEUE)
    await sender.sendMessages({
      body: message,
      contentType: 'application/json',
    })
    await sender.close()
  }

  it('happy path: message succeeds on first attempt', async () => {
    const testId = randomUUID()
    await sendTestMessage({ testId, action: 'succeed' })

    const result = await receiveResult(testId, 30_000)
    expect(result.testId).toBe(testId)
    expect(result.publishCount).toBe(1)
    expect(result.status).toBe('completed')
  })

  it('retry then succeed: message fails then succeeds on retry', async () => {
    const testId = randomUUID()
    await sendTestMessage({ testId, action: 'fail-then-succeed', succeedAfterAttempt: 2 })

    // With delaySeconds=1 and maxRetries=2, the second attempt should arrive after ~1s
    const result = await receiveResult(testId, 30_000)
    expect(result.testId).toBe(testId)
    expect(result.publishCount).toBe(2)
    expect(result.status).toBe('completed')
  })

  it('max retries exceeded: message goes to DLQ', async () => {
    const testId = randomUUID()
    await sendTestMessage({ testId, action: 'always-fail' })

    // With maxRetries=2 and delaySeconds=1:
    // attempt 1 fails → reschedule (publishCount=2)
    // attempt 2 fails → reschedule (publishCount=3)
    // attempt 3: publishCount(3) > maxRetries(2) → throw MaxRetriesReachedError → DLQ
    // Total wait ~2-3s for retries + processing time
    const dlqMessage = await receiveDLQMessage(RETRY_QUEUE, 30_000)
    expect(dlqMessage).toBeDefined()

    // The DLQ message body is a retry wrapper containing the original message
    const body = dlqMessage.body as { message?: { testId: string }, testId?: string }
    const dlqTestId = body.message?.testId ?? body.testId
    expect(dlqTestId).toBe(testId)
  })
})

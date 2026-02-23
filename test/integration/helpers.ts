import { ServiceBusClient, type ServiceBusReceivedMessage } from '@azure/service-bus'

export const EMULATOR_CONNECTION_STRING =
  'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true'

export const RETRY_QUEUE = 'retry-test-queue'
export const RESULTS_QUEUE = 'retry-test-results-queue'
export const EXPIRY_QUEUE = 'retry-test-expiry-queue'

export function createServiceBusClient(): ServiceBusClient {
  return new ServiceBusClient(EMULATOR_CONNECTION_STRING)
}

/**
 * Drain all messages from a queue so tests start with a clean slate.
 * Receives in ReceiveAndDelete mode with a short timeout.
 */
export async function purgeQueue(queueName: string): Promise<number> {
  const client = createServiceBusClient()
  try {
    const receiver = client.createReceiver(queueName, { receiveMode: 'receiveAndDelete' })

    let total = 0
    let batch: unknown[]
    do {
      batch = await receiver.receiveMessages(100, { maxWaitTimeInMs: 1000 })
      total += batch.length
    } while (batch.length > 0)

    await receiver.close()
    return total
  } finally {
    await client.close()
  }
}

export type ResultMessage = {
  testId: string
  publishCount: number
  status: string
  expiry?: string
  processedAtMs: number
  messageIndex?: number
}

/**
 * Receive a result message from the results queue, filtering by testId.
 * Polls until a matching message arrives or the timeout expires.
 */
export async function receiveResult(testId: string, timeoutMs = 30_000): Promise<ResultMessage> {
  const client = createServiceBusClient()
  try {
    const receiver = client.createReceiver(RESULTS_QUEUE)
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const messages = await receiver.receiveMessages(1, { maxWaitTimeInMs: Math.min(5000, deadline - Date.now()) })
      for (const msg of messages) {
        const body = msg.body as ResultMessage
        if (body.testId === testId) {
          await receiver.completeMessage(msg)
          await receiver.close()
          return body
        }
        // Not our message — abandon it so other tests can pick it up
        await receiver.abandonMessage(msg)
      }
    }
    await receiver.close()
    throw new Error(`No result message for testId=${testId} within ${timeoutMs}ms`)
  } finally {
    await client.close()
  }
}

/**
 * Receive result messages for a set of testIds from the results queue.
 * Polls until all matching messages arrive or the timeout expires.
 */
export async function receiveAllResults(testIds: string[], timeoutMs = 30_000): Promise<Map<string, ResultMessage>> {
  const results = new Map<string, ResultMessage>()
  const remaining = new Set(testIds)
  const client = createServiceBusClient()
  try {
    const receiver = client.createReceiver(RESULTS_QUEUE)
    const deadline = Date.now() + timeoutMs

    while (remaining.size > 0 && Date.now() < deadline) {
      const messages = await receiver.receiveMessages(1, { maxWaitTimeInMs: Math.min(5000, deadline - Date.now()) })
      for (const msg of messages) {
        const body = msg.body as ResultMessage
        if (remaining.has(body.testId)) {
          results.set(body.testId, body)
          remaining.delete(body.testId)
          await receiver.completeMessage(msg)
        } else {
          // Not one of ours — abandon it so other tests can pick it up
          await receiver.abandonMessage(msg)
        }
      }
    }

    await receiver.close()

    if (remaining.size > 0) {
      throw new Error(`No result message for testIds: ${[...remaining].join(', ')} within ${timeoutMs}ms`)
    }
    return results
  } finally {
    await client.close()
  }
}

/**
 * Receive a message from the dead-letter sub-queue of the given queue.
 */
export async function receiveDLQMessage(queueName: string, timeoutMs = 30_000): Promise<ServiceBusReceivedMessage> {
  const client = createServiceBusClient()
  try {
    const dlqPath = `${queueName}/$deadletterqueue`
    const receiver = client.createReceiver(dlqPath, { receiveMode: 'receiveAndDelete' })
    const messages = await receiver.receiveMessages(1, { maxWaitTimeInMs: timeoutMs })
    await receiver.close()

    if (messages.length === 0) {
      throw new Error(`No DLQ message on ${dlqPath} within ${timeoutMs}ms`)
    }
    return messages[0]!
  } finally {
    await client.close()
  }
}

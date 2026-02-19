import { ServiceBusClient } from '@azure/service-bus'

const RESULTS_QUEUE = 'retry-test-results-queue'

export type TestResult = {
  testId: string
  publishCount: number
  status: 'completed' | 'error-no-sequence-number'
  expiry?: string
  processedAtMs: number
  messageIndex?: number
}

let senderPromise: ReturnType<typeof createSender> | undefined

function createSender() {
  const connectionString = process.env['SERVICEBUS_CONNECTION_STRING']!
  const client = new ServiceBusClient(connectionString)
  return client.createSender(RESULTS_QUEUE)
}

function getSender() {
  if (!senderPromise) {
    senderPromise = createSender()
  }
  return senderPromise
}

export async function writeResult(result: TestResult): Promise<void> {
  const sender = await getSender()
  await sender.sendMessages({
    body: result,
    contentType: 'application/json',
  })
}

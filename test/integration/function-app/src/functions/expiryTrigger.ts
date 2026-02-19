import { serviceBusQueueWithRetries, type ServiceBusRetryInvocationContext } from '@joost_lambregts/azure-functions-servicebus-retries'
import { writeResult } from './resultsWriter.js'

export type ExpiryTestMessage = {
  testId: string
  action: 'succeed' | 'fail-then-succeed' | 'always-fail' | 'fail-after-delay'
  succeedAfterAttempt?: number
  delayMs?: number
}

const connectionString = process.env['SERVICEBUS_CONNECTION_STRING']
  ?? 'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true'

// delaySeconds=3 is intentionally longer than the short TTLs used in expiry tests,
// so the retry message's TTL (= remaining original TTL) expires before delivery.
serviceBusQueueWithRetries<ExpiryTestMessage>('expiryTestTrigger', {
  queueName: 'retry-test-expiry-queue',
  connection: 'SERVICEBUS_CONNECTION_STRING',
  retryConfiguration: {
    maxRetries: 5,
    retryStrategy: 'fixed',
    delaySeconds: 3,
    jitter: 0,
    sendConnectionString: connectionString,
    preserveExpiresAt: true,
  },
  handler: async (message: ExpiryTestMessage, context: ServiceBusRetryInvocationContext) => {
    context.info(`Expiry trigger: testId=${message.testId}, action=${message.action}, publishCount=${context.publishCount}`)

    switch (message.action) {
      case 'succeed':
        await writeResult({ testId: message.testId, publishCount: context.publishCount, status: 'completed', expiry: context.triggerMetadata?.expiresAtUtc  as string | undefined, processedAtMs: Date.now() })
        return

      case 'fail-then-succeed':
        if (context.publishCount >= (message.succeedAfterAttempt ?? 2)) {
          await writeResult({ testId: message.testId, publishCount: context.publishCount, status: 'completed', expiry: context.triggerMetadata?.expiresAtUtc  as string | undefined, processedAtMs: Date.now() })
          return
        }
        throw new Error(`Intentional failure for testId=${message.testId}, attempt ${context.publishCount}`)

      case 'always-fail':
        throw new Error(`Intentional permanent failure for testId=${message.testId}`)

      case 'fail-after-delay':
        await new Promise<void>(resolve => setTimeout(resolve, message.delayMs ?? 5000))
        throw new Error(`Delayed failure for testId=${message.testId}`)
    }
  },
})

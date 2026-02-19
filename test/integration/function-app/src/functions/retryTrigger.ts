import { serviceBusQueueWithRetries, type ServiceBusRetryInvocationContext } from '@joost_lambregts/azure-functions-servicebus-retries'
import { writeResult } from './resultsWriter.js'

export type TestMessage = {
  testId: string
  action: 'succeed' | 'fail-then-succeed' | 'always-fail'
  succeedAfterAttempt?: number
}

const connectionString = process.env['SERVICEBUS_CONNECTION_STRING']
  ?? 'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true'

serviceBusQueueWithRetries<TestMessage>('retryTestTrigger', {
  queueName: 'retry-test-queue',
  connection: 'SERVICEBUS_CONNECTION_STRING',
  retryConfiguration: {
    maxRetries: 2,
    retryStrategy: 'fixed',
    delaySeconds: 1,
    jitter: 0,
    sendConnectionString: connectionString,
    preserveExpiresAt: false,
  },
  handler: async (message: TestMessage, context: ServiceBusRetryInvocationContext) => {
    context.info(`Handler invoked: testId=${message.testId}, action=${message.action}, publishCount=${context.publishCount}`)

    switch (message.action) {
      case 'succeed':
        await writeResult({ testId: message.testId, publishCount: context.publishCount, status: 'completed', processedAtMs: Date.now() })
        return

      case 'fail-then-succeed':
        if (context.publishCount >= (message.succeedAfterAttempt ?? 2)) {
          await writeResult({ testId: message.testId, publishCount: context.publishCount, status: 'completed', processedAtMs: Date.now() })
          return
        }
        throw new Error(`Intentional failure for testId=${message.testId}, attempt ${context.publishCount}`)

      case 'always-fail':
        throw new Error(`Intentional permanent failure for testId=${message.testId}, attempt ${context.publishCount}`)
    }
  },
})

import { serviceBusQueueWithRetries, type ServiceBusRetryInvocationContext } from '@joost_lambregts/azure-functions-servicebus-retries'
import { writeResult } from './resultsWriter.js'

export type SessionTestMessage = {
  testId: string
  messageIndex: number
  action: 'succeed' | 'fail-then-succeed' | 'always-fail'
  succeedAfterAttempt?: number
}

const connectionString = process.env['SERVICEBUS_CONNECTION_STRING']
  ?? 'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true'

serviceBusQueueWithRetries<SessionTestMessage>('sessionRetryTestTrigger', {
  queueName: 'retry-test-session-queue',
  connection: 'SERVICEBUS_CONNECTION_STRING',
  isSessionsEnabled: true,
  retryConfiguration: {
    maxRetries: 2,
    retryStrategy: 'fixed',
    delaySeconds: 2,
    jitter: 0,
    sendConnectionString: connectionString,
    preserveExpiresAt: false,
    preserveSessionOrdering: true,
    sessionOrderingIncrementMs: 500,
  },
  handler: async (message: SessionTestMessage, context: ServiceBusRetryInvocationContext) => {
    context.info(`Session trigger: testId=${message.testId}, messageIndex=${message.messageIndex}, action=${message.action}, publishCount=${context.publishCount}, sequenceNumber=${context.originalBindingData.sequenceNumber}`)

    if (context.originalBindingData.sequenceNumber === undefined) {
      context.warn('SRBLIB: sequenceNumber missing from trigger metadata — session ordering is inactive')
      await writeResult({
        testId: message.testId,
        publishCount: context.publishCount,
        status: 'error-no-sequence-number',
        processedAtMs: Date.now(),
        messageIndex: message.messageIndex,
      })
      return
    }

    switch (message.action) {
      case 'succeed':
        await writeResult({
          testId: message.testId,
          publishCount: context.publishCount,
          status: 'completed',
          processedAtMs: Date.now(),
          messageIndex: message.messageIndex,
        })
        return

      case 'fail-then-succeed':
        if (context.publishCount >= (message.succeedAfterAttempt ?? 2)) {
          await writeResult({
            testId: message.testId,
            publishCount: context.publishCount,
            status: 'completed',
            processedAtMs: Date.now(),
            messageIndex: message.messageIndex,
          })
          return
        }
        throw new Error(`Intentional failure for testId=${message.testId}, messageIndex=${message.messageIndex}, attempt ${context.publishCount}`)

      case 'always-fail':
        throw new Error(`Intentional permanent failure for testId=${message.testId}, messageIndex=${message.messageIndex}`)
    }
  },
})

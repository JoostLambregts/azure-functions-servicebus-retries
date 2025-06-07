import { app, type FunctionHandler, type FunctionResult, type InvocationContext, type ServiceBusQueueFunctionOptions } from '@azure/functions'
import { type ServiceBusMessage, type ServiceBusSender, ServiceBusClient } from  '@azure/service-bus'
import { MaxRetriesReachedError, MessageExpiredError } from '../util/error.js'
import { calculateBackoffSeconds, type RetryConfiguration } from './backoff.js'
import { fromZonedTime } from 'date-fns-tz'


/**
 * Represents the configuration for retrying operations with Service Bus.
 *
 * @property maxRetries - The maximum number of retry attempts.
 * @property retryStrategy - The type of backoff strategy to use: 'fixed', 'linear' or 'exponential' (default: 'fixed').
 * @property delaySeconds - The initial delay in milliseconds between retries (for both strategies).
 * @property maxDelaySeconds - Optional: The maximum delay for exponential backoff (to avoid too long waits).
 * @property exponentialFactor - Optional: The factor by which the delay increases for exponential backoff (default: 2).
 * @property linearIncreaseSeconds - Optional: The factor by which the delay increases for linear backoff.
 * @property jitter - Optional: The jitter factor to randomize the delay (default: 0.1).
 * @property sendConnectionString - The connection string used to send messages to the Service Bus.
 */
export type ServiceBusRetryConfiguration = RetryConfiguration & {
  sendConnectionString: string
}

export type ServiceBusBindingData = {
  messageId?: string
  enqueuedTimeUtc?: string
  expiresAtUtc?: string
}


/**
 * Represents a message that can be retried, extending a generic object type `T`.
 *
 * @template T - The base type of the message, which must extend `object`.
 *
 * @property originalBindingData - The binding data associated with the Service Bus message.
 * @property tryCount - The number of retry attempts made for this message.
 */
export type ServiceBusRetryMessageWrapper<T> = {
  message: T,
  originalBindingData: ServiceBusBindingData
  publishCount: number
}

export type ServiceBusRetryInvocationContext = InvocationContext & {
  originalBindingData?: ServiceBusBindingData
  publishCount: number
}

type TypedFunctionHandler<T, S> = (message: T, context: ServiceBusRetryInvocationContext) => FunctionResult<S>
type MessageExpiryStrategy = 'ignore' | 'reject' | 'handle'
export type ServiceBusQueueRetryFunctionOptions<T,S> = Omit<ServiceBusQueueFunctionOptions, 'handler'> & {
  retryConfiguration?: ServiceBusRetryConfiguration,
  messageExpiryStrategy?: MessageExpiryStrategy,
  handler: TypedFunctionHandler<T, S>
}

export function serviceBusQueueWithRetries<T = unknown, S = void>(name: string, options: ServiceBusQueueRetryFunctionOptions<T,S>): void {
  const { retryConfiguration, handler } = options
  if (retryConfiguration === undefined) {
    // console.log is used here instead of logger because the logger is not yet initialized at this point. Console.log messages will be visible in the Azure Functions logs.
    console.log('SRBLIB: No retry configuration provided, using default service bus queue trigger')
    //@ts-expect-error The serviceBusQueue expects the handler to accept a message of type unkonwn, as it does not know the type of the message.
    //We chose to enable more type safety by allowing the user to specify the type of the message at the creation of the trigger.
    return app.serviceBusQueue(name, options)
  }
  console.log('SRBLIB: Retry configuration provided, using retryable service bus queue trigger')
  const sender = new ServiceBusClient(retryConfiguration.sendConnectionString).createSender(options.queueName)
  const retryWrapper: FunctionHandler = async (message: T | ServiceBusRetryMessageWrapper<T>, context: InvocationContext): Promise<S | void> => executeWithRetries<T, S>(handler, message, context, sender, retryConfiguration, options.messageExpiryStrategy)
  const newOptions = {
    ...options,
    handler: retryWrapper,
  }
  delete newOptions.retryConfiguration
  return app.serviceBusQueue(name, newOptions)
}

async function executeWithRetries<T = unknown,S = void>(handler: TypedFunctionHandler<T,S>, message: T | ServiceBusRetryMessageWrapper<T>, originalContext: InvocationContext, sender: ServiceBusSender, retryConfiguration: ServiceBusRetryConfiguration, messageExpiryStrategy: MessageExpiryStrategy = 'handle'): Promise<S | void> {
  let unwrappedMessage: T | undefined
  const context = originalContext as ServiceBusRetryInvocationContext
  if (typeof message === 'object' && 'publishCount' in message!) {
    const wrappedMessage = message as ServiceBusRetryMessageWrapper<T>
    unwrappedMessage = wrappedMessage.message
    context.publishCount = wrappedMessage.publishCount
    context.originalBindingData = wrappedMessage.originalBindingData
    context.debug(`SRBLIB: Processing message with originalMessageId: ${wrappedMessage.originalBindingData?.messageId} and publishcount: ${wrappedMessage.publishCount}`)
  } else {
    unwrappedMessage = message as T
    context.publishCount = 1
    context.originalBindingData = { messageId: context.triggerMetadata?.messageId  as string,
      expiresAtUtc: context.triggerMetadata?.expiresAtUtc as string,
      enqueuedTimeUtc: context.triggerMetadata?.enqueuedTimeUtc as string
    }
    context.debug(`SRBLIB: Processing first execution of message with id: ${context.triggerMetadata?.messageId}`)
  }

  const isExpired = isMessageExpired(context)
  if (isExpired) {
    if (messageExpiryStrategy === 'reject') {
      context.info(`Message expired for message originalId / retryId: ${context.originalBindingData.messageId} / ${context.triggerMetadata?.messageId}`)
      throw new MessageExpiredError(context.originalBindingData?.messageId as string, context.triggerMetadata?.messageId as string)
    } else if (messageExpiryStrategy === 'ignore') {
      context.info(`Ignoring expired message for message originalId / retryId: ${context.originalBindingData.messageId} / ${context.triggerMetadata?.messageId}`)
      return
    }
  }

  try {
    return await handler(unwrappedMessage, context)
  } catch {
    throwErrorIfMaxRetriesReached(retryConfiguration, context)
    await resendWithDelay(retryConfiguration, context, unwrappedMessage, sender)
  }
}

function throwErrorIfMaxRetriesReached(retryConfiguration: ServiceBusRetryConfiguration, context: ServiceBusRetryInvocationContext) {
  if (context.publishCount > retryConfiguration.maxRetries) {
    context.info(`Max retries (${retryConfiguration.maxRetries}) reached for message originalId / retryId: ${context.originalBindingData?.messageId} / ${context.triggerMetadata?.messageId}`)
    throw new MaxRetriesReachedError(context.originalBindingData?.messageId as string, context.triggerMetadata?.messageId as string)
  }
}

function isMessageExpired(context: ServiceBusRetryInvocationContext): boolean {
  if (context.originalBindingData?.expiresAtUtc == undefined) {
    return false
  }
  // For some reason, the expiresAtUTC date string does not have time zone information so we can't just use new Date() or parseDate()
  const expiry = fromZonedTime(context.originalBindingData?.expiresAtUtc, 'UTC')
  return expiry < new Date()
}

async function resendWithDelay<T>(retryConfiguration: ServiceBusRetryConfiguration, context: ServiceBusRetryInvocationContext, message: T, sender: ServiceBusSender) {
  const delaySeconds = calculateBackoffSeconds(retryConfiguration, context.publishCount - 1)
  const wrappedMessage: ServiceBusRetryMessageWrapper<T> = {
    message,
    originalBindingData: context.originalBindingData as ServiceBusBindingData,
    publishCount: context.publishCount + 1
  }
  const serviceBusMessage: ServiceBusMessage = {
    body: wrappedMessage,
    contentType: 'application/json',
    scheduledEnqueueTimeUtc: new Date(Date.now() + delaySeconds * 1000),
  }
  context.info(`Rescheduling message. Original messageId: ${context.originalBindingData?.messageId}, tryCount: ${context.publishCount}, delay: ${delaySeconds} seconds`)
  await sender.scheduleMessages(serviceBusMessage, serviceBusMessage.scheduledEnqueueTimeUtc as Date )
}
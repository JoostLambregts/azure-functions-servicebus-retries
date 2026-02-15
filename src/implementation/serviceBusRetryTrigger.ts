import { app, type FunctionHandler, type FunctionResult, type InvocationContext, type ServiceBusQueueFunctionOptions } from '@azure/functions'
import { type ServiceBusMessage, type ServiceBusSender, ServiceBusClient } from  '@azure/service-bus'
import { MaxRetriesReachedError, MessageExpiredError } from '../util/error.js'
import { calculateBackoffSeconds, type RetryConfiguration } from './backoff.js'
import { fromZonedTime } from 'date-fns-tz'
import { getLatestScheduledTimeForLowerSequence, addScheduledEntry, removeScheduledEntry } from './sessionOrderingStore.js'


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
 * @property preserveSessionOrdering - Optional: Whether to preserve session ordering for retries (default: false). If true, messages will be rescheduled to ensure they are processed in sequence.
 * @property sessionOrderingIncrementMs - Optional: The number of milliseconds to increment the scheduled time for retries when preserving session ordering (default: 1000ms). This is used to ensure that retried messages are scheduled after any existing messages with lower sequence numbers.
 * @property preserveExpiresAt - Optional: Whether to preserve the original expiresAtUtc value when rescheduling messages (default: true). If true, the expiresAtUtc value from the original message will be used to calculate the timeToLive for retried messages, ensuring that they expire at the same time as the original message.
 */
export type ServiceBusRetryConfiguration = RetryConfiguration & {
  sendConnectionString: string
  preserveSessionOrdering?: boolean
  sessionOrderingIncrementMs?: number
  preserveExpiresAt?: boolean
}

export type ServiceBusBindingData = {
  messageId?: string
  enqueuedTimeUtc?: string
  expiresAtUtc?: string
  sessionId?: string
  sequenceNumber?: number
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
  originalBindingData: ServiceBusBindingData
  publishCount: number
}

type TypedFunctionHandler<T, S> = (message: T, context: ServiceBusRetryInvocationContext) => FunctionResult<S>
export type ServiceBusQueueRetryFunctionOptions<T,S> = Omit<ServiceBusQueueFunctionOptions, 'handler'> & {
  retryConfiguration?: ServiceBusRetryConfiguration,
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
  const retryWrapper: FunctionHandler = async (message: T | ServiceBusRetryMessageWrapper<T>, context: InvocationContext): Promise<S | void> => executeWithRetries<T, S>(handler, message, context, sender, retryConfiguration)
  const newOptions = {
    ...options,
    handler: retryWrapper,
  }
  delete newOptions.retryConfiguration
  return app.serviceBusQueue(name, newOptions)
}

async function executeWithRetries<T = unknown,S = void>(handler: TypedFunctionHandler<T,S>, message: T | ServiceBusRetryMessageWrapper<T>, originalContext: InvocationContext, sender: ServiceBusSender, retryConfiguration: ServiceBusRetryConfiguration): Promise<S | void> {
  const { context, unwrappedMessage } = buildRetryInvocationContextAndMessage(originalContext, message)
  const wrappedMessage: ServiceBusRetryMessageWrapper<T> = {
    message: unwrappedMessage,
    originalBindingData: context.originalBindingData,
    publishCount: context.publishCount
  }

  const preserveSessionOrdering = retryConfiguration.preserveSessionOrdering === true && context.originalBindingData.sessionId !== undefined && context.originalBindingData.sequenceNumber !== undefined
  const rescheduled = await rescheduleForSessionOrderingIfNeeded(context, wrappedMessage, retryConfiguration, sender)
  if (rescheduled) {
    return
  }

  try {
    const result = await handler(unwrappedMessage, context)
    if (preserveSessionOrdering) {
      removeScheduledEntry(context.originalBindingData.sessionId!, context.originalBindingData.sequenceNumber!)
    }
    return result
  } catch {
    throwErrorIfMaxRetriesReached(retryConfiguration, context, preserveSessionOrdering)
    await resendWithDelay(retryConfiguration, context, wrappedMessage, sender)
  }
}

function throwErrorIfMaxRetriesReached(retryConfiguration: ServiceBusRetryConfiguration, context: ServiceBusRetryInvocationContext, preserveSessionOrdering: boolean): void {
  if (context.publishCount > retryConfiguration.maxRetries) {
    context.info(`Max retries (${retryConfiguration.maxRetries}) reached for message originalId / retryId: ${context.originalBindingData?.messageId} / ${context.triggerMetadata?.messageId}`)
    if (preserveSessionOrdering) {
      removeScheduledEntry(context.originalBindingData.sessionId!, context.originalBindingData.sequenceNumber!)
    }
    throw new MaxRetriesReachedError(context.originalBindingData?.messageId as string, context.triggerMetadata?.messageId as string)
  }
}

async function resendWithDelay<T>(retryConfiguration: ServiceBusRetryConfiguration, context: ServiceBusRetryInvocationContext, wrappedMessage: ServiceBusRetryMessageWrapper<T>, sender: ServiceBusSender): Promise<void>  {
  const delaySeconds = calculateBackoffSeconds(retryConfiguration, context.publishCount - 1)
  const scheduledTime = new Date(Date.now() + delaySeconds * 1000)

  wrappedMessage.publishCount += 1

  await resendMessage(retryConfiguration, context, wrappedMessage, sender, scheduledTime)
}

async function resendMessage<T>(retryConfiguration: ServiceBusRetryConfiguration, context: ServiceBusRetryInvocationContext, wrappedMessage: ServiceBusRetryMessageWrapper<T>, sender: ServiceBusSender, scheduledTime: Date): Promise<void>  {

  const serviceBusMessage: ServiceBusMessage = {
    body: wrappedMessage,
    contentType: 'application/json',
    scheduledEnqueueTimeUtc: scheduledTime,
    sessionId: context.originalBindingData.sessionId,
  }
  applyTtlIfNeeded(retryConfiguration, context, serviceBusMessage)

  if (retryConfiguration.preserveSessionOrdering === true && (serviceBusMessage.timeToLive === undefined || serviceBusMessage.timeToLive > 1)) {
    addScheduledEntry(context.originalBindingData.sessionId!, context.originalBindingData.sequenceNumber!, scheduledTime)
  }
  context.info(`Rescheduling message. Original messageId: ${context.originalBindingData?.messageId}, tryCount: ${context.publishCount}, scheduledTime: ${scheduledTime.toISOString()}`)
  await sender.scheduleMessages(serviceBusMessage, serviceBusMessage.scheduledEnqueueTimeUtc as Date )
}

function applyTtlIfNeeded(retryConfiguration: ServiceBusRetryConfiguration, context: ServiceBusRetryInvocationContext, serviceBusMessage: ServiceBusMessage): void {
  if (retryConfiguration.preserveExpiresAt !== false && context.originalBindingData.expiresAtUtc !== undefined) {
    const expiryDateTime = fromZonedTime(context.originalBindingData.expiresAtUtc, 'UTC')
    const timeToLive = expiryDateTime.getTime() - Date.now()
    if (timeToLive <= 0) {
      if (retryConfiguration.preserveSessionOrdering === true && context.originalBindingData.sessionId !== undefined && context.originalBindingData.sequenceNumber !== undefined) {
        removeScheduledEntry(context.originalBindingData.sessionId, context.originalBindingData.sequenceNumber)
      }
      throw new MessageExpiredError(context.originalBindingData?.messageId as string, context.triggerMetadata?.messageId as string)
    }
    serviceBusMessage.timeToLive = timeToLive
  }
}

function buildRetryInvocationContextAndMessage<T>(originalContext: InvocationContext, message: T | ServiceBusRetryMessageWrapper<T>): { context: ServiceBusRetryInvocationContext, unwrappedMessage: T } {
  const context = originalContext as ServiceBusRetryInvocationContext
  let unwrappedMessage: T
  if (typeof message === 'object' && message !== null && 'publishCount' in message) {
    const wrappedMessage = message
    unwrappedMessage = wrappedMessage.message
    context.publishCount = wrappedMessage.publishCount
    context.originalBindingData = wrappedMessage.originalBindingData
    context.debug(`SRBLIB: Processing message with originalMessageId: ${wrappedMessage.originalBindingData?.messageId} and publishcount: ${wrappedMessage.publishCount}`)
  } else {
    unwrappedMessage = message
    context.publishCount = 1
    const bindingData: ServiceBusBindingData = {
      messageId: context.triggerMetadata?.messageId as string,
      expiresAtUtc: context.triggerMetadata?.expiresAtUtc as string,
      enqueuedTimeUtc: context.triggerMetadata?.enqueuedTimeUtc as string,
    }
    if (context.triggerMetadata?.sessionId !== undefined) {
      bindingData.sessionId = context.triggerMetadata.sessionId as string
    }
    if (context.triggerMetadata?.sequenceNumber !== undefined) {
      bindingData.sequenceNumber = context.triggerMetadata.sequenceNumber as number
    }
    context.originalBindingData = bindingData
    context.debug(`SRBLIB: Processing first execution of message with id: ${context.triggerMetadata?.messageId}`)
  }
  return { context, unwrappedMessage }
}

async function rescheduleForSessionOrderingIfNeeded<T>(context: ServiceBusRetryInvocationContext, wrappedMessage: ServiceBusRetryMessageWrapper<T>, retryConfiguration: ServiceBusRetryConfiguration, sender: ServiceBusSender): Promise<boolean>  {
  const sessionId = context.originalBindingData.sessionId
  const sequenceNumber = context.originalBindingData.sequenceNumber
  const preserveOrdering = retryConfiguration.preserveSessionOrdering === true && sessionId !== undefined && sequenceNumber !== undefined
  const incrementMs = retryConfiguration.sessionOrderingIncrementMs ?? 1000

  if (preserveOrdering) {
    const latestLower = getLatestScheduledTimeForLowerSequence(sessionId, sequenceNumber)
    if (latestLower !== undefined && latestLower > new Date()) {
      const scheduledTime = new Date(latestLower.getTime() + incrementMs)
      addScheduledEntry(sessionId, sequenceNumber, scheduledTime)
      context.info(`SRBLIB: Session ordering: rescheduling message (seq ${sequenceNumber}) after lower-sequence message scheduled at ${latestLower.toISOString()}`)
      await resendMessage(retryConfiguration, context, wrappedMessage, sender, scheduledTime)
      return true
    }
  }
  return false
}

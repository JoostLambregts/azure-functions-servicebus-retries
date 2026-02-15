import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mock } from 'vitest-mock-extended'
import { app, ServiceBusQueueFunctionOptions } from '@azure/functions'
import { ServiceBusSender, ServiceBusClient } from '@azure/service-bus'
import { serviceBusQueueWithRetries, ServiceBusRetryConfiguration, ServiceBusRetryInvocationContext } from '../src/implementation/serviceBusRetryTrigger.js'
import { MessageExpiredError } from '../src/util/error.js'
import { clearSession, getLatestScheduledTimeForLowerSequence } from '../src/implementation/sessionOrderingStore.js'

vi.useFakeTimers()
vi.setSystemTime(new Date('2024-01-01T00:00:00Z'))

vi.mock('@azure/functions', () => ({
  app: { serviceBusQueue: vi.fn() }
}))

vi.mock('@azure/service-bus', () => ({
  ServiceBusClient: vi.fn(),
  ServiceBusSender: vi.fn()
}))

const serviceBusClientMock = mock<ServiceBusClient>()
const mockSender = mock<ServiceBusSender>()
vi.mocked(ServiceBusClient).mockReturnValue(serviceBusClientMock)
serviceBusClientMock.createSender.mockReturnValue(mockSender)


describe('serviceBusQueueWithRetries - no retry configuration', () => {

  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('should use default service bus queue trigger when no retry configuration is provided', () => {
    const options: ServiceBusQueueFunctionOptions = {
      queueName: 'test-queue',
      connection: 'test-connection',
      handler: vi.fn()
    }

    serviceBusQueueWithRetries('test-function', options)
    expect(app.serviceBusQueue).toHaveBeenCalledWith('test-function', options)
  })
})

describe('executeWithRetries', async () => {
  const mockContext = mock<ServiceBusRetryInvocationContext>()
  const retryConfig: ServiceBusRetryConfiguration = {
    maxRetries: 3,
    delaySeconds: 5,
    retryStrategy: 'exponential',
    sendConnectionString: 'test-send-connection'
  }
  
  const handler = vi.fn().mockResolvedValue('success')

  await serviceBusQueueWithRetries('test-function', {
    queueName: 'test-queue',
    connection: 'test-connection',
    handler,
    retryConfiguration: retryConfig
  })
  
  const retryHandler = vi.mocked(app.serviceBusQueue).mock.calls[0][1].handler

  beforeEach(() => {
    vi.clearAllMocks()
    mockContext.triggerMetadata = {
      messageId: 'test-message-id',
      enqueuedTimeUtc: '2024-01-01T00:00:00.000',
      someOhterProperty: 'test'
    }
  })

  test('should execute handler successfully on first try', async () => {
    const message = { test: 'data' }
    await retryHandler(message, mockContext)

    expect(handler).toHaveBeenCalledWith(message, mockContext)
    expect(mockContext.originalBindingData).toMatchObject({messageId: 'test-message-id', enqueuedTimeUtc: '2024-01-01T00:00:00.000',})
    expect(mockContext.publishCount).toBe(1)
    expect(mockSender.scheduleMessages).not.toHaveBeenCalled()
  })

  test('should send a retry message to serviceBus when function execution fails', async () => {
    const message = { test: 'data' }
    handler.mockRejectedValue(new Error('Function execution failed'))
    await retryHandler(message, mockContext)

    
    expect(mockSender.scheduleMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          message: {test: 'data'},
          publishCount: 2,
          originalBindingData: {messageId: 'test-message-id', enqueuedTimeUtc: '2024-01-01T00:00:00.000'}
        },
        scheduledEnqueueTimeUtc: new Date('2024-01-01T00:00:05Z')
      }), new Date('2024-01-01T00:00:05Z'))
  })

  test('Should pass retry count to backoff calculation', async () => {
    const message = { message: 'data', 
      publishCount: 3,
      originalBindingData: {
        messageId: 'test-message-id-original',
        enqueuedTimeUtc: new Date().toISOString()
      }
    }
    handler.mockRejectedValue(new Error('Function execution failed'))
    await retryHandler(message, mockContext)

    expect(mockSender.scheduleMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          message: 'data',
          publishCount: 4,
          originalBindingData: {
            messageId: 'test-message-id-original',
            enqueuedTimeUtc: new Date().toISOString()
          }
        },
        // three retries with exponential backoff = 5 * 2^(3 - 1) = 20 seconds
        scheduledEnqueueTimeUtc: new Date('2024-01-01T00:00:20Z')
      }), new Date('2024-01-01T00:00:20Z'))
  })

  test('Should not republish when max retries reached, and throw an error', async () => {
    const message = { message: 'data', 
      publishCount: 4,
      originalBindingData: {
        messageId: 'test-message-id-original',
        enqueuedTimeUtc: new Date().toISOString()
      }
    }
    handler.mockRejectedValue(new Error('Function execution failed'))
    await expect(retryHandler(message, mockContext)).rejects.toThrow('Max retries reached for original messageId / current messageId: test-message-id-original / test-message-id')
    expect(mockSender.scheduleMessages).not.toHaveBeenCalled()
  })

  test('Should handle expired message as normal by default', async () => {
    const message = { message: 'data', 
      publishCount: 1,
      originalBindingData: {
        messageId: 'test-message-id-original',
        expiresAtUtc: '2023-12-31T23:59:59',
        enqueuedTimeUtc: new Date().toISOString()
      }
    }
    handler.mockResolvedValue('hello')
    const result = await retryHandler(message, mockContext)
    expect(result).toBe('hello')
  })

  test('Should set timeToLive on rescheduled message to match original expiry by default', async () => {
    const message = { message: 'data',
      publishCount: 1,
      originalBindingData: {
        messageId: 'test-message-id-original',
        expiresAtUtc: '2024-01-01T00:05:00',
        enqueuedTimeUtc: new Date().toISOString()
      }
    }
    handler.mockRejectedValue(new Error('Function execution failed'))
    await retryHandler(message, mockContext)

    expect(mockSender.scheduleMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        timeToLive: 300000, // 5 minutes in ms
      }),
      expect.any(Date)
    )
  })

  test('Should throw MessageExpiredError when rescheduling an already-expired message', async () => {
    const message = { message: 'data',
      publishCount: 1,
      originalBindingData: {
        messageId: 'test-message-id-original',
        expiresAtUtc: '2023-12-31T23:59:59',
        enqueuedTimeUtc: new Date().toISOString()
      }
    }
    handler.mockRejectedValue(new Error('Function execution failed'))
    await expect(retryHandler(message, mockContext)).rejects.toThrow(MessageExpiredError)
    expect(mockSender.scheduleMessages).not.toHaveBeenCalled()
  })

  test('Should not set timeToLive on rescheduled message when preserveExpiresAt is false', async () => {
    const noExpiryConfig: ServiceBusRetryConfiguration = {
      ...retryConfig,
      preserveExpiresAt: false
    }
    await serviceBusQueueWithRetries('test-no-expiry', {
      queueName: 'test-queue',
      connection: 'test-connection',
      handler,
      retryConfiguration: noExpiryConfig
    })
    const calls = vi.mocked(app.serviceBusQueue).mock.calls
    const noExpiryHandler = calls[calls.length - 1][1].handler

    const message = { message: 'data',
      publishCount: 1,
      originalBindingData: {
        messageId: 'test-message-id-original',
        expiresAtUtc: '2024-01-01T00:05:00',
        enqueuedTimeUtc: new Date().toISOString()
      }
    }
    handler.mockRejectedValue(new Error('Function execution failed'))
    await noExpiryHandler(message, mockContext)

    const scheduledMessage = mockSender.scheduleMessages.mock.calls[0][0] as Record<string, unknown>
    expect(scheduledMessage.timeToLive).toBeUndefined()
  })
})

describe('session ordering', async () => {
  const mockContext = mock<ServiceBusRetryInvocationContext>()
  const sessionRetryConfig: ServiceBusRetryConfiguration = {
    maxRetries: 3,
    delaySeconds: 5,
    retryStrategy: 'fixed',
    sendConnectionString: 'test-send-connection',
    preserveSessionOrdering: true,
    sessionOrderingIncrementMs: 500
  }

  const handler = vi.fn().mockResolvedValue('success')

  await serviceBusQueueWithRetries('session-test-function', {
    queueName: 'test-queue',
    connection: 'test-connection',
    handler,
    retryConfiguration: sessionRetryConfig
  })

  const calls = vi.mocked(app.serviceBusQueue).mock.calls
  const retryHandler = calls[calls.length - 1][1].handler

  beforeEach(() => {
    vi.clearAllMocks()
    clearSession('session-A')
    mockContext.triggerMetadata = {
      messageId: 'msg-1',
      enqueuedTimeUtc: '2024-01-01T00:00:00.000',
      sessionId: 'session-A',
      sequenceNumber: 10,
    }
  })

  test('should process message normally when no lower-sequence message is pending', async () => {
    const message = { test: 'data' }
    await retryHandler(message, mockContext)

    expect(handler).toHaveBeenCalledWith(message, mockContext)
    expect(mockSender.scheduleMessages).not.toHaveBeenCalled()
  })

  test('should set sessionId on outgoing message when rescheduling after failure', async () => {
    const message = { test: 'data' }
    handler.mockRejectedValueOnce(new Error('fail'))
    await retryHandler(message, mockContext)

    expect(mockSender.scheduleMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-A',
        scheduledEnqueueTimeUtc: new Date('2024-01-01T00:00:05Z')
      }),
      new Date('2024-01-01T00:00:05Z')
    )
  })

  test('should reschedule message when a lower-sequence message is scheduled in the future', async () => {
    // First: simulate a lower-sequence message (seq 5) that failed and is scheduled for retry
    mockContext.triggerMetadata = {
      messageId: 'msg-0',
      enqueuedTimeUtc: '2024-01-01T00:00:00.000',
      sessionId: 'session-A',
      sequenceNumber: 5,
    }
    handler.mockRejectedValueOnce(new Error('fail'))
    await retryHandler({ test: 'first' }, mockContext)

    vi.clearAllMocks()

    // Now: a higher-sequence message (seq 10) arrives
    mockContext.triggerMetadata = {
      messageId: 'msg-1',
      enqueuedTimeUtc: '2024-01-01T00:00:00.000',
      sessionId: 'session-A',
      sequenceNumber: 10,
    }
    handler.mockResolvedValue('success')
    await retryHandler({ test: 'second' }, mockContext)

    // Handler should NOT have been called
    expect(handler).not.toHaveBeenCalled()
    // Message should be rescheduled after the lower-sequence message + increment
    expect(mockSender.scheduleMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-A',
        scheduledEnqueueTimeUtc: new Date('2024-01-01T00:00:05.500Z'), // 5s + 500ms increment
        body: expect.objectContaining({
          publishCount: 1, // not incremented, this is a session ordering reschedule not a retry
        })
      }),
      new Date('2024-01-01T00:00:05.500Z')
    )
  })

  test('should remove entry from store on successful completion', async () => {
    // First: fail a message to add it to store
    mockContext.triggerMetadata = {
      messageId: 'msg-0',
      enqueuedTimeUtc: '2024-01-01T00:00:00.000',
      sessionId: 'session-A',
      sequenceNumber: 5,
    }
    handler.mockRejectedValueOnce(new Error('fail'))
    await retryHandler({ test: 'first' }, mockContext)

    vi.clearAllMocks()

    // Now process the retry successfully (wrapped message)
    const wrappedMessage = {
      message: { test: 'first' },
      publishCount: 2,
      originalBindingData: {
        messageId: 'msg-0',
        enqueuedTimeUtc: '2024-01-01T00:00:00.000',
        sessionId: 'session-A',
        sequenceNumber: 5,
      }
    }
    handler.mockResolvedValue('done')
    await retryHandler(wrappedMessage, mockContext)

    expect(handler).toHaveBeenCalled()

    // Now a higher-sequence message should process normally (no lower pending)
    vi.clearAllMocks()
    mockContext.triggerMetadata = {
      messageId: 'msg-1',
      enqueuedTimeUtc: '2024-01-01T00:00:00.000',
      sessionId: 'session-A',
      sequenceNumber: 10,
    }
    handler.mockResolvedValue('success')
    await retryHandler({ test: 'second' }, mockContext)
    expect(handler).toHaveBeenCalled()
    expect(mockSender.scheduleMessages).not.toHaveBeenCalled()
  })

  test('should adjust retry delay when a lower-sequence message is scheduled later', async () => {
    // Fail seq 5 with a large delay (it'll be scheduled at +5s)
    mockContext.triggerMetadata = {
      messageId: 'msg-0',
      enqueuedTimeUtc: '2024-01-01T00:00:00.000',
      sessionId: 'session-A',
      sequenceNumber: 5,
    }
    handler.mockRejectedValueOnce(new Error('fail'))
    await retryHandler({ test: 'first' }, mockContext)

    vi.clearAllMocks()

    // Now fail seq 10 - its own backoff would be +5s, same as seq 5
    // With ordering, it should be pushed to seq 5's time + increment
    mockContext.triggerMetadata = {
      messageId: 'msg-1',
      enqueuedTimeUtc: '2024-01-01T00:00:00.000',
      sessionId: 'session-A',
      sequenceNumber: 10,
    }
    handler.mockRejectedValueOnce(new Error('fail'))
    await retryHandler({ test: 'second' }, mockContext)

    expect(mockSender.scheduleMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-A',
        scheduledEnqueueTimeUtc: new Date('2024-01-01T00:00:05.500Z'), // lower at 5s + 500ms
      }),
      new Date('2024-01-01T00:00:05.500Z')
    )
  })

  test('should remove entry from store when max retries reached', async () => {
    // Fail seq 5 to add it to the store
    mockContext.triggerMetadata = {
      messageId: 'msg-0',
      enqueuedTimeUtc: '2024-01-01T00:00:00.000',
      sessionId: 'session-A',
      sequenceNumber: 5,
    }
    handler.mockRejectedValueOnce(new Error('fail'))
    await retryHandler({ test: 'first' }, mockContext)

    // Verify entry exists in store
    expect(getLatestScheduledTimeForLowerSequence('session-A', 10)).toBeDefined()

    vi.clearAllMocks()

    // Now seq 5 comes back as a retry but has exceeded max retries
    const wrappedMessage = {
      message: { test: 'first' },
      publishCount: 4, // > maxRetries (3)
      originalBindingData: {
        messageId: 'msg-0',
        enqueuedTimeUtc: '2024-01-01T00:00:00.000',
        sessionId: 'session-A',
        sequenceNumber: 5,
      }
    }
    handler.mockRejectedValueOnce(new Error('fail'))
    await expect(retryHandler(wrappedMessage, mockContext)).rejects.toThrow('Max retries reached')

    // Verify entry was cleaned up from store
    expect(getLatestScheduledTimeForLowerSequence('session-A', 10)).toBeUndefined()
  })
})

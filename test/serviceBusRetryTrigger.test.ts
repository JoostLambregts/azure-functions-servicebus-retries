import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mock } from 'vitest-mock-extended'
import { app, ServiceBusQueueFunctionOptions } from '@azure/functions'
import { ServiceBusSender, ServiceBusClient } from '@azure/service-bus'
import { serviceBusQueueWithRetries, ServiceBusRetryConfiguration, ServiceBusRetryInvocationContext } from '../src/implementation/serviceBusRetryTrigger.js'
import { MessageExpiredError } from '../src/util/error.js'

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

  test('Should ignore expiry message when messageExpiryStrategy is set to ignore', async () => {
    await serviceBusQueueWithRetries('test-function', {
        queueName: 'test-queue',
        connection: 'test-connection',
        handler,
        retryConfiguration: retryConfig,
        messageExpiryStrategy: 'ignore'
      })
  
    const retryHandler = vi.mocked(app.serviceBusQueue).mock.calls[0][1].handler

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
    expect(result).not.toBeDefined()
    expect(handler).not.toHaveBeenCalled()
  })

  test('Should throw an error when when messageExpiryStrategy is set to reject', async () => {
    await serviceBusQueueWithRetries('test-function', {
        queueName: 'test-queue',
        connection: 'test-connection',
        handler,
        retryConfiguration: retryConfig,
        messageExpiryStrategy: 'reject'
      })
  
    const retryHandler = vi.mocked(app.serviceBusQueue).mock.calls[0][1].handler

    const message = { message: 'data', 
      publishCount: 1,
      originalBindingData: {
        messageId: 'test-message-id-original',
        expiresAtUtc: '2023-12-31T23:59:59',
        enqueuedTimeUtc: new Date().toISOString()
      }
    }

    await expect(retryHandler(message, mockContext)).rejects.toThrow(MessageExpiredError)
  })
})
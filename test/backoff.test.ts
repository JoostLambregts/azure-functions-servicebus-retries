import { describe, it, expect } from 'vitest'
import { calculateBackoffSeconds, RetryConfiguration, RetryStrategy } from '../src/implementation/backoff'

describe('calculateBackoffSeconds', () => {
    it('should return fixed delay for fixed strategy', () => {
        const config: RetryConfiguration = {
            maxRetries: 5,
            retryStrategy: 'fixed',
            delaySeconds: 1000,
        }
        const result = calculateBackoffSeconds(config, 3)
        expect(result).toBe(1000)
    })

    it('should calculate exponential backoff delay', () => {
        const config: RetryConfiguration = {
            maxRetries: 5,
            retryStrategy: 'exponential',
            delaySeconds: 1000,
            exponentialFactor: 2,
        }
        const result = calculateBackoffSeconds(config, 3)
        expect(result).toBe(8000) // 1000 * 2^3
    })

    it('should cap exponential backoff delay at maxDelaySeconds', () => {
        const config: RetryConfiguration = {
            maxRetries: 5,
            retryStrategy: 'exponential',
            delaySeconds: 1000,
            exponentialFactor: 2,
            maxDelaySeconds: 5000,
        }
        const result = calculateBackoffSeconds(config, 3)
        expect(result).toBe(5000) // Capped at maxDelaySeconds
    })

    it('should calculate linear backoff delay', () => {
        const config: RetryConfiguration = {
            maxRetries: 5,
            retryStrategy: 'linear',
            delaySeconds: 1000,
            linearIncreaseSeconds: 500,
        }
        const result = calculateBackoffSeconds(config, 3)
        expect(result).toBe(2500) // 1000 + 500 * 3
    })

    it('should add jitter to the delay', () => {
        const config: RetryConfiguration = {
            maxRetries: 5,
            retryStrategy: 'fixed',
            delaySeconds: 1000,
            jitter: 0.1,
        }
        const result = calculateBackoffSeconds(config, 3)
        expect(result).toBeGreaterThanOrEqual(900) // 1000 - 10%
        expect(result).toBeLessThanOrEqual(1100) // 1000 + 10%
    })

    it('should throw an error for unknown retry strategy', () => {
        const config: RetryConfiguration = {
            maxRetries: 5,
            retryStrategy: 'unknown' as RetryStrategy,
            delaySeconds: 1000,
        }
        expect(() => calculateBackoffSeconds(config, 3)).toThrowError('Unknown retry strategy: unknown')
    })

    it('should ensure delay is non-negative', () => {
        const config: RetryConfiguration = {
            maxRetries: 5,
            retryStrategy: 'fixed',
            delaySeconds: -1000,
        }
        const result = calculateBackoffSeconds(config, 3)
        expect(result).toBe(0) // Non-negative delay
    })
})
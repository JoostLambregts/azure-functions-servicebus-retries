export type RetryStrategy = 'fixed' | 'exponential' | 'linear'

export type RetryConfiguration = {
  maxRetries: number               // Maximum number of retry attempts
  retryStrategy?: RetryStrategy    // Type of backoff strategy: 'fixed', 'linear' or 'exponential' (default: 'fixed')
  delaySeconds: number             // Initial delay in milliseconds between retries (for all strategies)
  maxDelaySeconds?: number         // Optional: Maximum delay for exponential backoff (to avoid too long waits)
  exponentialFactor?: number       // Optional: Factor by which delay increases for exponential backoff (default: 2)
  linearIncreaseSeconds?: number   // Optional: Factor by which delay increases for linear backoff
  jitter?: number                  // Optional: jitter factor to randomize delay (default: 0.1)
}

export function calculateBackoffSeconds(config: RetryConfiguration, retryCount: number): number {
  const {
    retryStrategy = 'fixed',
    delaySeconds,
    maxDelaySeconds,
    linearIncreaseSeconds = 1000,
    exponentialFactor = 2,
    jitter = 0,
  } = config

  let delay

  if (retryStrategy === 'fixed') {
    delay = delaySeconds
  } else if (retryStrategy === 'exponential') {
    delay = delaySeconds * Math.pow(exponentialFactor, retryCount)
    if (maxDelaySeconds !== undefined) {
      delay = Math.min(delay, maxDelaySeconds) // Cap the delay at maxDelay if defined
    }
  } else if (retryStrategy === 'linear') {
    delay = delaySeconds + linearIncreaseSeconds * retryCount
  } else {
    throw new Error(`Unknown retry strategy: ${retryStrategy}`)
  }

  if (jitter > 0) {
    // Add randomness to delay to avoid simultaneous retries
    const randomJitter = delay * jitter * (Math.random() * 2 - 1)
    delay += randomJitter
  }

  return Math.max(0, Math.round(delay)) // Ensure delay is non-negative and rounded to the nearest millisecond
}
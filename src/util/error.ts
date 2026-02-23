export class CustomError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, { cause })

    // assign the error class name in custom error
    this.name = this.constructor.name

    // capturing the stack trace keeps the reference to the error class
    Error.captureStackTrace(this, this.constructor)
  }
}

export class MaxRetriesReachedError extends CustomError {
  constructor (originalMessageId: string, currentMessageId: string) {
    super(`Max retries reached for original messageId / current messageId: ${originalMessageId} / ${currentMessageId}`)
  }
}

export class MessageExpiredError extends CustomError {
  constructor (originalMessageId: string, currentMessageId: string) {
    super(`Scheduled time for message is after message expiry for original messageId / current messageId: ${originalMessageId} / ${currentMessageId}`)
  }
}
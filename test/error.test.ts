import { ensureError } from '../src/util/error.js'
import { describe, test, expect } from 'vitest'

describe('Test ensureError functionality', () => {
  const msg = 'test message'

  test('should return given Error', () => {
    const error = new Error(msg)
    expect(ensureError(error)).toBe(error)
  })

  test('should still convert to an error when receiving a string', () => {
    expect(ensureError(msg).toString()).toBe(`Error: "${msg}"`)
  })

  test('should still convert to an error when receiving undefined', () => {
    let value
    expect(ensureError(value).toString()).toBe('Error')
  })

  test('should still convert to an error when receiving null', () => {
    const value = null
    expect(ensureError(value).toString()).toBe('Error: null')
  })

  test('should still convert to an error when not able to stringify the thrown value', () => {
    const value = BigInt(1)
    expect(ensureError(value).toString()).toBe('Error: [Unable to stringify the thrown value]')
  })
})

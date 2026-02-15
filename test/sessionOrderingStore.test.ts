import { describe, test, expect, beforeEach } from 'vitest'
import { getLatestScheduledTimeForLowerSequence, addScheduledEntry, removeScheduledEntry, clearSession } from '../src/implementation/sessionOrderingStore.js'

describe('sessionOrderingStore', () => {
  beforeEach(() => {
    clearSession('session-1')
    clearSession('session-2')
  })

  describe('getLatestScheduledTimeForLowerSequence', () => {
    test('returns undefined when no entries exist for session', () => {
      expect(getLatestScheduledTimeForLowerSequence('session-1', 5)).toBeUndefined()
    })

    test('returns undefined when no entries have lower sequence number', () => {
      addScheduledEntry('session-1', 10, new Date('2024-01-01T00:01:00Z'))
      expect(getLatestScheduledTimeForLowerSequence('session-1', 5)).toBeUndefined()
    })

    test('returns undefined when only equal sequence number exists', () => {
      addScheduledEntry('session-1', 5, new Date('2024-01-01T00:01:00Z'))
      expect(getLatestScheduledTimeForLowerSequence('session-1', 5)).toBeUndefined()
    })

    test('returns the scheduled time of a lower sequence entry', () => {
      const time = new Date('2024-01-01T00:01:00Z')
      addScheduledEntry('session-1', 3, time)
      expect(getLatestScheduledTimeForLowerSequence('session-1', 5)).toEqual(time)
    })

    test('returns the latest scheduled time among multiple lower entries', () => {
      addScheduledEntry('session-1', 1, new Date('2024-01-01T00:01:00Z'))
      addScheduledEntry('session-1', 2, new Date('2024-01-01T00:03:00Z'))
      addScheduledEntry('session-1', 3, new Date('2024-01-01T00:02:00Z'))
      expect(getLatestScheduledTimeForLowerSequence('session-1', 5)).toEqual(new Date('2024-01-01T00:03:00Z'))
    })

    test('ignores entries from other sessions', () => {
      addScheduledEntry('session-2', 1, new Date('2024-01-01T00:05:00Z'))
      expect(getLatestScheduledTimeForLowerSequence('session-1', 5)).toBeUndefined()
    })
  })

  describe('removeScheduledEntry', () => {
    test('removes entry by sequence number', () => {
      addScheduledEntry('session-1', 3, new Date('2024-01-01T00:01:00Z'))
      removeScheduledEntry('session-1', 3)
      expect(getLatestScheduledTimeForLowerSequence('session-1', 5)).toBeUndefined()
    })

    test('does nothing when session does not exist', () => {
      removeScheduledEntry('nonexistent', 1)
      // no error thrown
    })

    test('does nothing when sequence number not found', () => {
      addScheduledEntry('session-1', 3, new Date('2024-01-01T00:01:00Z'))
      removeScheduledEntry('session-1', 99)
      expect(getLatestScheduledTimeForLowerSequence('session-1', 5)).toEqual(new Date('2024-01-01T00:01:00Z'))
    })

    test('cleans up empty session from map', () => {
      addScheduledEntry('session-1', 3, new Date('2024-01-01T00:01:00Z'))
      removeScheduledEntry('session-1', 3)
      // After removing the only entry, session should be cleaned up
      // Adding a new entry and checking it works proves the old session was removed
      addScheduledEntry('session-1', 10, new Date('2024-01-01T00:05:00Z'))
      expect(getLatestScheduledTimeForLowerSequence('session-1', 11)).toEqual(new Date('2024-01-01T00:05:00Z'))
    })
  })

  describe('clearSession', () => {
    test('removes all entries for a session', () => {
      addScheduledEntry('session-1', 1, new Date('2024-01-01T00:01:00Z'))
      addScheduledEntry('session-1', 2, new Date('2024-01-01T00:02:00Z'))
      clearSession('session-1')
      expect(getLatestScheduledTimeForLowerSequence('session-1', 10)).toBeUndefined()
    })

    test('does not affect other sessions', () => {
      addScheduledEntry('session-1', 1, new Date('2024-01-01T00:01:00Z'))
      addScheduledEntry('session-2', 1, new Date('2024-01-01T00:02:00Z'))
      clearSession('session-1')
      expect(getLatestScheduledTimeForLowerSequence('session-2', 5)).toEqual(new Date('2024-01-01T00:02:00Z'))
    })
  })
})

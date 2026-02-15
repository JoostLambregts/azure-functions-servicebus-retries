type ScheduledEntry = {
  sequenceNumber: number
  scheduledTime: Date
}

const store = new Map<string, ScheduledEntry[]>()

export function getLatestScheduledTimeForLowerSequence(sessionId: string, sequenceNumber: number): Date | undefined {
  const entries = store.get(sessionId)
  if (entries === undefined) return undefined

  let latest: Date | undefined
  for (const entry of entries) {
    if (entry.sequenceNumber < sequenceNumber) {
      if (latest === undefined || entry.scheduledTime > latest) {
        latest = entry.scheduledTime
      }
    }
  }
  return latest
}

export function addScheduledEntry(sessionId: string, sequenceNumber: number, scheduledTime: Date): void {
  let entries = store.get(sessionId)
  if (entries === undefined) {
    entries = []
    store.set(sessionId, entries)
  }
  entries.push({ sequenceNumber, scheduledTime })
}

export function removeScheduledEntry(sessionId: string, sequenceNumber: number): void {
  const entries = store.get(sessionId)
  if (entries === undefined) return

  const index = entries.findIndex(e => e.sequenceNumber === sequenceNumber)
  if (index !== -1) {
    entries.splice(index, 1)
  }
  if (entries.length === 0) {
    store.delete(sessionId)
  }
}

export function clearSession(sessionId: string): void {
  store.delete(sessionId)
}

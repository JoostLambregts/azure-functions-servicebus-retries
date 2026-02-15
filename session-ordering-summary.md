# Session-aware ordering for Service Bus retries

## Problem

When sessions are enabled on a Service Bus queue, message ordering within a session matters. The existing retry mechanism (complete + reschedule with delay) breaks ordering because subsequent messages in the session continue processing while a failed message waits for its retry.

## Solution

An opt-in `preserveSessionOrdering` flag that tracks scheduled retry messages per session in an in-memory store. When enabled, incoming messages check whether a lower-sequence message is already scheduled for retry. If so, the incoming message is rescheduled to run after it, preserving order.

## Configuration

Two new optional fields on `ServiceBusRetryConfiguration`:

```typescript
preserveSessionOrdering?: boolean   // default: false
sessionOrderingIncrementMs?: number  // gap between ordered messages, default: 1000ms
```

Session ordering only activates when `preserveSessionOrdering` is `true` **and** the trigger metadata contains both `sessionId` and `sequenceNumber` (i.e., the queue has sessions enabled).

## How it works

### Message arrival (before handler call)
If a lower-sequence message in the same session is scheduled in the future, the current message is rescheduled after it (+ increment). The `publishCount` is **not** incremented since this isn't a retry.

### Handler failure (retry path)
1. Backoff delay is calculated as before
2. If a lower-sequence message is scheduled later than the calculated retry time, the retry time is pushed to after that message (+ increment)
3. The entry is recorded in the store
4. `sessionId` is set on the outgoing `ServiceBusMessage` so it stays in the same session

### Handler success
The entry for the completed message is removed from the store.

## Files changed

| File | Change |
|------|--------|
| `src/implementation/sessionOrderingStore.ts` | **New** - In-memory `Map<sessionId, entries[]>` store with add/remove/query/clear functions |
| `src/implementation/serviceBusRetryTrigger.ts` | Added config fields, `sessionId`/`sequenceNumber` to binding data, ordering logic in `executeWithRetries`, session-aware `resendWithDelay`, new `rescheduleForSessionOrdering` helper |
| `test/sessionOrderingStore.test.ts` | **New** - 12 unit tests for the store |
| `test/serviceBusRetryTrigger.test.ts` | 5 new integration tests for session ordering behavior |

## Store API (`sessionOrderingStore.ts`)

- `getLatestScheduledTimeForLowerSequence(sessionId, sequenceNumber)` - finds the latest scheduled time among entries with a lower sequence number
- `addScheduledEntry(sessionId, sequenceNumber, scheduledTime)` - records a scheduled message
- `removeScheduledEntry(sessionId, sequenceNumber)` - removes an entry, cleans up empty sessions
- `clearSession(sessionId)` - removes all entries for a session (testing/cleanup)

## Test coverage

All 37 tests pass. Coverage: 99.11% statements, 97.43% branches, 100% functions.

## Limitations

- The store is in-memory and per-process. If multiple Azure Functions instances process the same session (which shouldn't happen with sessions, as sessions lock to a single instance), they won't share state.
- The store grows with the number of pending retries. Entries are cleaned up on success and on session clear, but if messages are abandoned without completing, entries remain.

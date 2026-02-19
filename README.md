# Service Bus Trigger Retry Extension

## Disclaimer
This package was created as a temporary workaround for issue https://github.com/Azure/azure-service-bus/issues/454. I intend to preserve this package for the foreseeable future, but I am the only preserveer and as such there is a risk involved with depending on this package. If your usecase is for an important project, consider just copying the code from github.

Please read the [limitations](#limitations)

## Context and purpose
Currently, the Azure Functions Service Bus Queue trigger lacks retry functionality that supports any kind of backoff. 
When a function execution fails, the message is abandoned and immediately becomes available on Service bus again. As a consequence, when a down stream dependency of your function becomes temporaraly unavailable causing your function execution to fail, each failing message immediately get processed a number of times equal to the maxTryCount set on the servicebus queue. This is likely to only increase the issues with the downstream service.

There is a github feature request for Azure Service Bus to fix this: https://github.com/Azure/azure-service-bus/issues/454. This issue is years old, and though it is planned to be fixed this year there is no commitment to that timeline.

The purpose of this library is to provide a wrapper around the ```app.serviceBusQueue()``` trigger from the ```@azure/functions``` NodeJS package. The wrapper provides retry functionality with a configruable backoff strategy. The backoff is achieved by rescheduling the messages on Service Bus. 

The message will be republished in a json wrapper, with additional context about the original message as well as a republish count.

```typescript
type ServiceBusRetryMessageWrapper<T> = {
  message: T, // the original message
  originalBindingData: ServiceBusBindingData
  publishCount: number
}

type ServiceBusBindingData = {
  messageId?: string
  enqueuedTimeUtc?: string
  expiresAtUtc?: string
  sessionId?: string
  sequenceNumber?: number
}
```

The message will be unwrapped by the trigger functionality before being passed to your handler function. The originalBindingData and publishCount from the wrapper will be added to the Context object passed to the handler instead, so that you do have access to it in your function code. 

## Usage
Usage is the similar to the regular app.serviceBusQueue(), except a retryConfiguration is added. Additionally, the function optionally accepts type parameters to specify the message type and return type of your handler function. The default is `<unknown, void>`.

A simple example would look like this:

```typescript
import { serviceBusQueueWithRetries, type ServiceBusRetryInvocationContext } from '@joost_lambregts/azure-functions-servicebus-retries'

serviceBusQueueWithRetries<MyMessageType, void>('flexReservationsToSteeringbox', {
  queueName: 'my-queue-name',
  connection: 'ENV_VAR_SERVICE_BUS_CONNECTION_STRING',
  handler: handleMessage,
  retryConfiguration: {
    maxRetries: 15,
    delaySeconds: 60,
    sendConnectionString: 'Endpoint=sb://some-namespace.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=some-key;EntityPath=some-queue',
  }
})

export async function handleMessage(message: MyMessageType, context: ServiceBusRetryInvocationContext): Promise<void> {
  // message has the same structure as how it was originally published to servive bus
  context.info(`${message.someProperty}`)
  if (context.publishCount > 1) {
    context.info(`Publish count: ${context.publishCount}`)
    context.info(`Original messageId: ${context.originalBindingData?.messageId}`)
    context.info(`Original publish time: ${context.originalBindingData?.enqueuedTimeUtc}`)
    context.info(`original expiration time: ${context.originalBindingData?.expiresAtUtc}`)
  }
}
```

retryConfiguration supports the following type:

``` typescript
type ServiceBusRetryConfiguration = {
  maxRetries: number;                  // Maximum number of retry attempts
  retryStrategy?: RetryStrategy;       // Type of backoff strategy: 'fixed', 'linear' or 'exponential' (default: 'fixed')
  delaySeconds: number;                // Initial delay in seconds between retries (for both strategies)
  maxDelaySeconds?: number;            // Optional: Maximum delay for exponential backoff (to avoid too long waits)
  exponentialFactor?: number;          // Optional: Factor by which delay increases for exponential backoff (default: 2)
  linearIncreaseSeconds?: number;      // Optional: Factor by which delay increases for linear backoff
  jitter?: number;                     // Optional: jitter factor to randomize delay (default: 0.1)
  sendConnectionString: string;        // Connection string for republishing messages to service bus.
  preserveExpiresAt?: boolean;         // Optional: preserve original TTL on retried messages (default: true). See Message expiry chapter.
  preserveSessionOrdering?: boolean;   // Optional: Preserve message ordering within sessions (default: false). See Session ordering chapter.
  sessionOrderingIncrementMs?: number; // Optional: Gap in ms between ordered session messages (default: 1000)
}
```

## Message expiry
Since each retry is a new message on Service Bus, the time to live for the message would normally reset, meaning retried messages could outlive the original message's intended expiry.

By default (`preserveExpiresAt: true`), the library sets the `timeToLive` on rescheduled messages so that they expire at the same time as the original message. If a message has already expired at the time it would be rescheduled, a `MessageExpiredError` is thrown instead, which will cause the message to go to the DLQ.

Set `preserveExpiresAt: false` to disable this behavior. When disabled, no `timeToLive` is set on rescheduled messages, meaning they will use the queue's default TTL.

## Session ordering
When sessions are enabled on a Service Bus queue, message ordering within a session matters. The retry mechanism (complete + reschedule with delay) can break this ordering because subsequent messages in the session may be processed while a failed message waits for its retry.

To preserve ordering, set `preserveSessionOrdering: true` in the retry configuration. When enabled, the library tracks scheduled retry messages per session in an in-memory store. Incoming messages check whether a lower-sequence message in the same session is already scheduled for retry. If so, the incoming message is rescheduled to run after it, preserving order.

Session ordering only activates when `preserveSessionOrdering` is `true` **and** the trigger metadata contains both `sessionId` and `sequenceNumber` (i.e., the queue has sessions enabled).

The `sessionOrderingIncrementMs` option (default: 1000ms) controls the time gap between ordered messages when rescheduling.

Note that the ordering store is in-memory and per-process. This effectively means that ordering is only preserved as long as the consuming instance does not restart. If you'd like this limitation removed, feel free to create an issue.

## Limitations
- Cardinality = many is currently not supported.
- Messages get reposted on Service Bus wrapped in a JSON object. This is unwrapped before being passed to your handler function, but any other consumers on the queue should be modified to expect the wrapped messages.

## Development

### Prerequisites

- Node.js ≥ 18
- [Azure Functions Core Tools](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local) (`func` on PATH)
- [Podman](https://podman.io/) with `podman compose` (or Docker with `docker compose`) — required for integration tests

### Install

```bash
npm install
```

### Unit tests

Runs ESLint, `tsc --noEmit`, and Vitest with coverage:

```bash
npm test
```

To run only Vitest (skip lint and type check):

```bash
npm run vitest-nolint
```

### Integration tests

Integration tests spin up a real Service Bus emulator and an Azure Functions host locally.

**1. Start the emulator** (once per dev session)

```bash
cd emulator
podman compose up -d
```

The emulator takes ~30 seconds to become healthy. The test runner waits for it automatically.

**2. Run the integration tests**

```bash
npm run test:integration
```

The setup automatically builds the library, installs and builds the test function app, and starts/stops the Azure Functions host around the suite.

**3. Stop the emulator when done**

```bash
cd emulator
podman compose down
```

#### Integration test layout

```
emulator/
  docker-compose.yml          # SQL Edge + Service Bus emulator containers
  Config.json                 # Queue definitions (including session-enabled queue)
test/integration/
  function-app/               # Minimal Azure Functions app used as test target
    src/functions/
      retryTrigger.ts         # Retry + backoff + DLQ scenarios
      expiryTrigger.ts        # Message expiry scenarios
      sessionRetryTrigger.ts  # Session ordering scenarios
  helpers.ts                  # Shared send/receive/purge utilities
  retry.test.ts               # Retry, backoff and DLQ tests
  session-ordering.test.ts    # Session ordering tests
  vitest.setup.integration.ts # Global setup/teardown
```

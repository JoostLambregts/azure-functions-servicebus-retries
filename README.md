# Service Bus Trigger Retry Extension

## Disclaimer
This package was created as a temporary workaround for issue https://github.com/Azure/azure-service-bus/issues/454. I intend to maintain this package for the foreseeable future, but I am the only maintainer and as such there is a risk involved with depending on this package. If your usecase is for an important project, consider just copying the code from github.

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
}
```

The message will be unwrapped by the trigger functionality before being passed to your handler function. The originalBindingData and publishCount from the wrapper will be added to the Context object passed to the handler instead, so that you do have access to it in your function code. 

## Usage
Usage is the similar to the regular app.serviceBusQueue(), except a retryConfiguration and messageExpiryStrategy is added. Additionally, the function optionally accepts type parameters to specify the message type and return type of your handler function. The default is `<unknown, void>`.

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
  messageExpiryStrategy: 'ignore' // see Message expiry chapter
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
type RetryConfiguration = {
  maxRetries: number;             // Maximum number of retry attempts
  retryStrategy?: RetryStrategy;  // Type of backoff strategy: 'fixed', 'linear' or 'exponential' (default: 'fixed')
  delaySeconds: number;           // Initial delay in milliseconds between retries (for both strategies)
  maxDelaySeconds?: number;       // Optional: Maximum delay for exponential backoff (to avoid too long waits)
  exponentialFactor?: number;     // Optional: Factor by which delay increases for exponential backoff (default: 2)
  linearIncreaseSeconds?: number; // Optional: Factor by which delay increases for linear backoff
  jitter?: number;                // Optional: jitter factor to randomize delay (default: 0.1)
  sendConnectionString: string;   // Connection string for republishing messages to service bus.
}
```

## Message expiry
Since each retry is a new message on Service Bus, the time to live for the message will reset. This means that it is possible that the trigger will consume a retry message even though the original has already expired. How the trigger handles this situation depends on the value of the 'messageExpiryStrategy' option provided to the trigger. 
- 'handle': The message is passed to your handler as normal. This if the default.
- 'ignore': The message is ignored. Note that this means that the message will not go to a DLQ, even though the message was never processed successfully
- 'reject': An error is thrown. This option is ideal if you want expired messages to end up in a DLQ.


## Limitations
- Sessions are not supported
- Cardinality = many is currently not supported.
- Messages get reposted on Service Bus wrapped in a JSON object. This is unwrapped before being passed to your handler function, but any other consumers on the queue should be modified to expect the wrapped messages.
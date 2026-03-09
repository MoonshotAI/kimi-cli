
# UpdateGlobalConfigResponse

Response after updating global config.

## Properties

Name | Type
------------ | -------------
`config` | [GlobalConfig](GlobalConfig.md)
`restartedSessionIds` | Array&lt;string&gt;
`skippedBusySessionIds` | Array&lt;string&gt;

## Example

```typescript
import type { UpdateGlobalConfigResponse } from ''

// TODO: Update the object below with actual values
const example = {
  "config": null,
  "restartedSessionIds": null,
  "skippedBusySessionIds": null,
} satisfies UpdateGlobalConfigResponse

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as UpdateGlobalConfigResponse
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)



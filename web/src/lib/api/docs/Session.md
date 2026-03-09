
# Session

Web UI session metadata.

## Properties

Name | Type
------------ | -------------
`sessionId` | string
`title` | string
`lastUpdated` | Date
`isRunning` | boolean
`status` | [SessionStatus](SessionStatus.md)
`workDir` | string
`sessionDir` | string
`archived` | boolean

## Example

```typescript
import type { Session } from ''

// TODO: Update the object below with actual values
const example = {
  "sessionId": null,
  "title": null,
  "lastUpdated": null,
  "isRunning": null,
  "status": null,
  "workDir": null,
  "sessionDir": null,
  "archived": null,
} satisfies Session

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as Session
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)



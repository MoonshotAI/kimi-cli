
# SessionStatus

Runtime status of a web session.

## Properties

Name | Type
------------ | -------------
`sessionId` | string
`state` | string
`seq` | number
`workerId` | string
`reason` | string
`detail` | string
`updatedAt` | Date

## Example

```typescript
import type { SessionStatus } from ''

// TODO: Update the object below with actual values
const example = {
  "sessionId": null,
  "state": null,
  "seq": null,
  "workerId": null,
  "reason": null,
  "detail": null,
  "updatedAt": null,
} satisfies SessionStatus

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as SessionStatus
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)



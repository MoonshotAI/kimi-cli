
# GenerateTitleRequest

Generate title request.  Parameters are optional - if not provided, the backend will read from wire.jsonl automatically.

## Properties

Name | Type
------------ | -------------
`userMessage` | string
`assistantResponse` | string

## Example

```typescript
import type { GenerateTitleRequest } from ''

// TODO: Update the object below with actual values
const example = {
  "userMessage": null,
  "assistantResponse": null,
} satisfies GenerateTitleRequest

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as GenerateTitleRequest
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)



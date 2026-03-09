
# UpdateConfigTomlResponse

Response after updating config.toml.

## Properties

Name | Type
------------ | -------------
`success` | boolean
`error` | string

## Example

```typescript
import type { UpdateConfigTomlResponse } from ''

// TODO: Update the object below with actual values
const example = {
  "success": null,
  "error": null,
} satisfies UpdateConfigTomlResponse

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as UpdateConfigTomlResponse
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)



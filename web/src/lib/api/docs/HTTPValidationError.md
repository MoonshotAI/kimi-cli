
# HTTPValidationError


## Properties

Name | Type
------------ | -------------
`detail` | [Array&lt;ValidationError&gt;](ValidationError.md)

## Example

```typescript
import type { HTTPValidationError } from ''

// TODO: Update the object below with actual values
const example = {
  "detail": null,
} satisfies HTTPValidationError

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as HTTPValidationError
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)



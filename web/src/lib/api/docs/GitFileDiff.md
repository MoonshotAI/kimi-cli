
# GitFileDiff

Single file git diff statistics

## Properties

Name | Type
------------ | -------------
`path` | string
`additions` | number
`deletions` | number
`status` | string

## Example

```typescript
import type { GitFileDiff } from ''

// TODO: Update the object below with actual values
const example = {
  "path": null,
  "additions": null,
  "deletions": null,
  "status": null,
} satisfies GitFileDiff

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as GitFileDiff
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)



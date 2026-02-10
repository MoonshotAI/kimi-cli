
# GitDiffStats

Git diff statistics for a work directory.

## Properties

Name | Type
------------ | -------------
`isGitRepo` | boolean
`hasChanges` | boolean
`totalAdditions` | number
`totalDeletions` | number
`files` | [Array&lt;GitFileDiff&gt;](GitFileDiff.md)
`error` | string

## Example

```typescript
import type { GitDiffStats } from ''

// TODO: Update the object below with actual values
const example = {
  "isGitRepo": null,
  "hasChanges": null,
  "totalAdditions": null,
  "totalDeletions": null,
  "files": null,
  "error": null,
} satisfies GitDiffStats

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as GitDiffStats
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)



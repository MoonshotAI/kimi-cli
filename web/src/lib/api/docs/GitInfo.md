
# GitInfo

Lightweight git probe response for the web UI.

## Properties

Name | Type
------------ | -------------
`isGitRepo` | boolean
`gitRoot` | string
`currentBranch` | string
`branches` | Array&lt;string&gt;
`headSha` | string

## Example

```typescript
import type { GitInfo } from ''

// TODO: Update the object below with actual values
const example = {
  "isGitRepo": null,
  "gitRoot": null,
  "currentBranch": null,
  "branches": null,
  "headSha": null,
} satisfies GitInfo

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as GitInfo
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)



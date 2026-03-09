
# ConfigModel

Model configuration for frontend.

## Properties

Name | Type
------------ | -------------
`provider` | string
`model` | string
`maxContextSize` | number
`capabilities` | [Set&lt;ModelCapability&gt;](ModelCapability.md)
`name` | string
`providerType` | [ProviderType](ProviderType.md)

## Example

```typescript
import type { ConfigModel } from ''

// TODO: Update the object below with actual values
const example = {
  "provider": null,
  "model": null,
  "maxContextSize": null,
  "capabilities": null,
  "name": null,
  "providerType": null,
} satisfies ConfigModel

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as ConfigModel
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)



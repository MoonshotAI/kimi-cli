# OpenInApi

All URIs are relative to *http://localhost*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**openInApiOpenInPost**](OpenInApi.md#openinapiopeninpost) | **POST** /api/open-in | Open a path in a local application |



## openInApiOpenInPost

> OpenInResponse openInApiOpenInPost(openInRequest)

Open a path in a local application

### Example

```ts
import {
  Configuration,
  OpenInApi,
} from '';
import type { OpenInApiOpenInPostRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new OpenInApi();

  const body = {
    // OpenInRequest
    openInRequest: ...,
  } satisfies OpenInApiOpenInPostRequest;

  try {
    const data = await api.openInApiOpenInPost(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **openInRequest** | [OpenInRequest](OpenInRequest.md) |  | |

### Return type

[**OpenInResponse**](OpenInResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Successful Response |  -  |
| **422** | Validation Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


# GitApi

All URIs are relative to *http://localhost*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**getGitInfoApiGitInfoGet**](GitApi.md#getgitinfoapigitinfoget) | **GET** /api/git/info | Probe a directory for git info |



## getGitInfoApiGitInfoGet

> GitInfo getGitInfoApiGitInfoGet(workDir)

Probe a directory for git info

Return git repo info for the given work_dir.

### Example

```ts
import {
  Configuration,
  GitApi,
} from '';
import type { GetGitInfoApiGitInfoGetRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new GitApi();

  const body = {
    // string
    workDir: workDir_example,
  } satisfies GetGitInfoApiGitInfoGetRequest;

  try {
    const data = await api.getGitInfoApiGitInfoGet(body);
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
| **workDir** | `string` |  | [Defaults to `undefined`] |

### Return type

[**GitInfo**](GitInfo.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Successful Response |  -  |
| **422** | Validation Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


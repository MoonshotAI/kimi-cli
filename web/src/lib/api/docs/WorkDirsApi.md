# WorkDirsApi

All URIs are relative to *http://localhost*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**getStartupDirApiWorkDirsStartupGet**](WorkDirsApi.md#getstartupdirapiworkdirsstartupget) | **GET** /api/work-dirs/startup | Get the startup directory |
| [**getWorkDirsApiWorkDirsGet**](WorkDirsApi.md#getworkdirsapiworkdirsget) | **GET** /api/work-dirs/ | List available work directories |



## getStartupDirApiWorkDirsStartupGet

> string getStartupDirApiWorkDirsStartupGet()

Get the startup directory

Get the directory where kimi web was started.

### Example

```ts
import {
  Configuration,
  WorkDirsApi,
} from '';
import type { GetStartupDirApiWorkDirsStartupGetRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new WorkDirsApi();

  try {
    const data = await api.getStartupDirApiWorkDirsStartupGet();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

**string**

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Successful Response |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## getWorkDirsApiWorkDirsGet

> Array&lt;string | null&gt; getWorkDirsApiWorkDirsGet()

List available work directories

Get a list of available work directories from metadata.

### Example

```ts
import {
  Configuration,
  WorkDirsApi,
} from '';
import type { GetWorkDirsApiWorkDirsGetRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new WorkDirsApi();

  try {
    const data = await api.getWorkDirsApiWorkDirsGet();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

**Array<string | null>**

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Successful Response |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


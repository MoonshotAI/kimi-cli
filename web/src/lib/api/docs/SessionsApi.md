# SessionsApi

All URIs are relative to *http://localhost*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**createSessionApiSessionsPost**](SessionsApi.md#createsessionapisessionspost) | **POST** /api/sessions/ | Create a new session |
| [**deleteSessionApiSessionsSessionIdDelete**](SessionsApi.md#deletesessionapisessionssessioniddelete) | **DELETE** /api/sessions/{session_id} | Delete a session |
| [**generateSessionTitleApiSessionsSessionIdGenerateTitlePost**](SessionsApi.md#generatesessiontitleapisessionssessionidgeneratetitlepost) | **POST** /api/sessions/{session_id}/generate-title | Generate session title using AI |
| [**getSessionApiSessionsSessionIdGet**](SessionsApi.md#getsessionapisessionssessionidget) | **GET** /api/sessions/{session_id} | Get session |
| [**getSessionFileApiSessionsSessionIdFilesPathGet**](SessionsApi.md#getsessionfileapisessionssessionidfilespathget) | **GET** /api/sessions/{session_id}/files/{path} | Get file or list directory from session work_dir |
| [**getSessionGitDiffApiSessionsSessionIdGitDiffGet**](SessionsApi.md#getsessiongitdiffapisessionssessionidgitdiffget) | **GET** /api/sessions/{session_id}/git-diff | Get git diff stats |
| [**getSessionUploadFileApiSessionsSessionIdUploadsPathGet**](SessionsApi.md#getsessionuploadfileapisessionssessioniduploadspathget) | **GET** /api/sessions/{session_id}/uploads/{path} | Get uploaded file from session uploads |
| [**listSessionsApiSessionsGet**](SessionsApi.md#listsessionsapisessionsget) | **GET** /api/sessions/ | List all sessions |
| [**updateSessionApiSessionsSessionIdPatch**](SessionsApi.md#updatesessionapisessionssessionidpatch) | **PATCH** /api/sessions/{session_id} | Update session |
| [**uploadSessionFileApiSessionsSessionIdFilesPost**](SessionsApi.md#uploadsessionfileapisessionssessionidfilespost) | **POST** /api/sessions/{session_id}/files | Upload file to session |



## createSessionApiSessionsPost

> Session createSessionApiSessionsPost(createSessionRequest)

Create a new session

Create a new session.

### Example

```ts
import {
  Configuration,
  SessionsApi,
} from '';
import type { CreateSessionApiSessionsPostRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new SessionsApi();

  const body = {
    // CreateSessionRequest (optional)
    createSessionRequest: ...,
  } satisfies CreateSessionApiSessionsPostRequest;

  try {
    const data = await api.createSessionApiSessionsPost(body);
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
| **createSessionRequest** | [CreateSessionRequest](CreateSessionRequest.md) |  | [Optional] |

### Return type

[**Session**](Session.md)

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


## deleteSessionApiSessionsSessionIdDelete

> any deleteSessionApiSessionsSessionIdDelete(sessionId)

Delete a session

Delete a session.

### Example

```ts
import {
  Configuration,
  SessionsApi,
} from '';
import type { DeleteSessionApiSessionsSessionIdDeleteRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new SessionsApi();

  const body = {
    // string
    sessionId: 38400000-8cf0-11bd-b23e-10b96e4ef00d,
  } satisfies DeleteSessionApiSessionsSessionIdDeleteRequest;

  try {
    const data = await api.deleteSessionApiSessionsSessionIdDelete(body);
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
| **sessionId** | `string` |  | [Defaults to `undefined`] |

### Return type

**any**

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


## generateSessionTitleApiSessionsSessionIdGenerateTitlePost

> GenerateTitleResponse generateSessionTitleApiSessionsSessionIdGenerateTitlePost(sessionId, generateTitleRequest)

Generate session title using AI

Generate a concise session title using AI based on the first conversation turn.  If request body is empty or parameters are missing, the backend will automatically read the first turn from wire.jsonl.

### Example

```ts
import {
  Configuration,
  SessionsApi,
} from '';
import type { GenerateSessionTitleApiSessionsSessionIdGenerateTitlePostRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new SessionsApi();

  const body = {
    // string
    sessionId: 38400000-8cf0-11bd-b23e-10b96e4ef00d,
    // GenerateTitleRequest (optional)
    generateTitleRequest: ...,
  } satisfies GenerateSessionTitleApiSessionsSessionIdGenerateTitlePostRequest;

  try {
    const data = await api.generateSessionTitleApiSessionsSessionIdGenerateTitlePost(body);
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
| **sessionId** | `string` |  | [Defaults to `undefined`] |
| **generateTitleRequest** | [GenerateTitleRequest](GenerateTitleRequest.md) |  | [Optional] |

### Return type

[**GenerateTitleResponse**](GenerateTitleResponse.md)

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


## getSessionApiSessionsSessionIdGet

> Session getSessionApiSessionsSessionIdGet(sessionId)

Get session

Get a session by ID.

### Example

```ts
import {
  Configuration,
  SessionsApi,
} from '';
import type { GetSessionApiSessionsSessionIdGetRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new SessionsApi();

  const body = {
    // string
    sessionId: 38400000-8cf0-11bd-b23e-10b96e4ef00d,
  } satisfies GetSessionApiSessionsSessionIdGetRequest;

  try {
    const data = await api.getSessionApiSessionsSessionIdGet(body);
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
| **sessionId** | `string` |  | [Defaults to `undefined`] |

### Return type

[**Session**](Session.md)

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


## getSessionFileApiSessionsSessionIdFilesPathGet

> any getSessionFileApiSessionsSessionIdFilesPathGet(sessionId, path)

Get file or list directory from session work_dir

Get a file or list directory from session work directory.

### Example

```ts
import {
  Configuration,
  SessionsApi,
} from '';
import type { GetSessionFileApiSessionsSessionIdFilesPathGetRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new SessionsApi();

  const body = {
    // string
    sessionId: 38400000-8cf0-11bd-b23e-10b96e4ef00d,
    // string
    path: path_example,
  } satisfies GetSessionFileApiSessionsSessionIdFilesPathGetRequest;

  try {
    const data = await api.getSessionFileApiSessionsSessionIdFilesPathGet(body);
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
| **sessionId** | `string` |  | [Defaults to `undefined`] |
| **path** | `string` |  | [Defaults to `undefined`] |

### Return type

**any**

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


## getSessionGitDiffApiSessionsSessionIdGitDiffGet

> GitDiffStats getSessionGitDiffApiSessionsSessionIdGitDiffGet(sessionId)

Get git diff stats

get git diff stats for the session\&#39;s work directory

### Example

```ts
import {
  Configuration,
  SessionsApi,
} from '';
import type { GetSessionGitDiffApiSessionsSessionIdGitDiffGetRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new SessionsApi();

  const body = {
    // string
    sessionId: 38400000-8cf0-11bd-b23e-10b96e4ef00d,
  } satisfies GetSessionGitDiffApiSessionsSessionIdGitDiffGetRequest;

  try {
    const data = await api.getSessionGitDiffApiSessionsSessionIdGitDiffGet(body);
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
| **sessionId** | `string` |  | [Defaults to `undefined`] |

### Return type

[**GitDiffStats**](GitDiffStats.md)

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


## getSessionUploadFileApiSessionsSessionIdUploadsPathGet

> any getSessionUploadFileApiSessionsSessionIdUploadsPathGet(sessionId, path)

Get uploaded file from session uploads

Get a file from a session\&#39;s uploads directory.

### Example

```ts
import {
  Configuration,
  SessionsApi,
} from '';
import type { GetSessionUploadFileApiSessionsSessionIdUploadsPathGetRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new SessionsApi();

  const body = {
    // string
    sessionId: 38400000-8cf0-11bd-b23e-10b96e4ef00d,
    // string
    path: path_example,
  } satisfies GetSessionUploadFileApiSessionsSessionIdUploadsPathGetRequest;

  try {
    const data = await api.getSessionUploadFileApiSessionsSessionIdUploadsPathGet(body);
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
| **sessionId** | `string` |  | [Defaults to `undefined`] |
| **path** | `string` |  | [Defaults to `undefined`] |

### Return type

**any**

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


## listSessionsApiSessionsGet

> Array&lt;Session&gt; listSessionsApiSessionsGet(limit, offset, q, archived)

List all sessions

List sessions with optional pagination and search.  Args:     limit: Maximum number of sessions to return (default 100, max 500).     offset: Number of sessions to skip (default 0).     q: Optional search query to filter by title or work_dir.     archived: Filter by archived status.         - None (default): Only return non-archived sessions.         - True: Only return archived sessions.

### Example

```ts
import {
  Configuration,
  SessionsApi,
} from '';
import type { ListSessionsApiSessionsGetRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new SessionsApi();

  const body = {
    // number (optional)
    limit: 56,
    // number (optional)
    offset: 56,
    // string (optional)
    q: q_example,
    // boolean (optional)
    archived: true,
  } satisfies ListSessionsApiSessionsGetRequest;

  try {
    const data = await api.listSessionsApiSessionsGet(body);
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
| **limit** | `number` |  | [Optional] [Defaults to `100`] |
| **offset** | `number` |  | [Optional] [Defaults to `0`] |
| **q** | `string` |  | [Optional] [Defaults to `undefined`] |
| **archived** | `boolean` |  | [Optional] [Defaults to `undefined`] |

### Return type

[**Array&lt;Session&gt;**](Session.md)

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


## updateSessionApiSessionsSessionIdPatch

> Session updateSessionApiSessionsSessionIdPatch(sessionId, updateSessionRequest)

Update session

Update a session (e.g., rename title or archive/unarchive).

### Example

```ts
import {
  Configuration,
  SessionsApi,
} from '';
import type { UpdateSessionApiSessionsSessionIdPatchRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new SessionsApi();

  const body = {
    // string
    sessionId: 38400000-8cf0-11bd-b23e-10b96e4ef00d,
    // UpdateSessionRequest
    updateSessionRequest: ...,
  } satisfies UpdateSessionApiSessionsSessionIdPatchRequest;

  try {
    const data = await api.updateSessionApiSessionsSessionIdPatch(body);
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
| **sessionId** | `string` |  | [Defaults to `undefined`] |
| **updateSessionRequest** | [UpdateSessionRequest](UpdateSessionRequest.md) |  | |

### Return type

[**Session**](Session.md)

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


## uploadSessionFileApiSessionsSessionIdFilesPost

> UploadSessionFileResponse uploadSessionFileApiSessionsSessionIdFilesPost(sessionId, file)

Upload file to session

Upload a file to a session.

### Example

```ts
import {
  Configuration,
  SessionsApi,
} from '';
import type { UploadSessionFileApiSessionsSessionIdFilesPostRequest } from '';

async function example() {
  console.log("🚀 Testing  SDK...");
  const api = new SessionsApi();

  const body = {
    // string
    sessionId: 38400000-8cf0-11bd-b23e-10b96e4ef00d,
    // Blob
    file: BINARY_DATA_HERE,
  } satisfies UploadSessionFileApiSessionsSessionIdFilesPostRequest;

  try {
    const data = await api.uploadSessionFileApiSessionsSessionIdFilesPost(body);
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
| **sessionId** | `string` |  | [Defaults to `undefined`] |
| **file** | `Blob` |  | [Defaults to `undefined`] |

### Return type

[**UploadSessionFileResponse**](UploadSessionFileResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: `multipart/form-data`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Successful Response |  -  |
| **422** | Validation Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


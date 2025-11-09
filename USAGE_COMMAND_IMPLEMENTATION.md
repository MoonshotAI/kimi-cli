# Implementation Summary: `/usage` Command

## Overview
Successfully implemented the `/usage` meta command for Kimi CLI as requested in GitHub Issue #186. This command allows users to conveniently check their API usage status and remaining quota in real-time.

## Changes Made

### 1. Core Implementation
**File**: `src/kimi_cli/ui/shell/metacmd.py`

Added a new async function `usage()` decorated with `@meta_command` that:
- Loads the current configuration to get API credentials
- Queries the API usage endpoint (`/usage` or `/account/usage` as fallback)
- Displays usage information in a formatted table using Rich library
- Handles various error scenarios gracefully

### 2. Features Implemented
- ✅ Query API usage endpoint with authentication
- ✅ Display current usage count
- ✅ Display total quota/limit
- ✅ Calculate and display remaining quota
- ✅ Calculate and display usage percentage
- ✅ Display reset date (if available)
- ✅ Fallback to alternative endpoint if primary returns 404
- ✅ Comprehensive error handling:
  - No model configured
  - Authentication errors (401)
  - Permission errors (403)
  - Network errors
  - API endpoint not available (404)

### 3. Testing
**File**: `tests/test_usage_metacmd.py`

Created comprehensive unit tests covering:
- ✅ Command registration verification
- ✅ Behavior when no model is configured
- ✅ Successful API response handling
- ✅ 404 fallback to alternative endpoint
- ✅ Authentication error handling
- ✅ Network error handling

All 6 tests pass successfully.

## Usage

Users can now run the following command in Kimi CLI:

```bash
/usage
```

### Example Output

When successful, the command displays a formatted table:

```
┌─────────────────────────────────────┐
│     API Usage Information           │
├──────────────────┬──────────────────┤
│ Metric           │ Value            │
├──────────────────┼──────────────────┤
│ Current Usage    │ 1,000            │
│ Total Quota      │ 10,000           │
│ Remaining        │ 9,000            │
│ Usage Percentage │ 10.00%           │
│ Reset Date       │ 2025-12-01       │
└──────────────────┴──────────────────┘
```

### Error Messages

- **No model configured**: "No model configured. Please run /setup first."
- **Authentication failed**: "Authentication failed. Please check your API key."
- **Access forbidden**: "Access forbidden. You may not have permission to view usage data."
- **Endpoint not available**: "Usage endpoint not available for this API provider."
- **Network error**: "Network error: [error details]"

## Technical Details

### API Endpoints Tried
1. Primary: `{base_url}/usage`
2. Fallback: `{base_url}/account/usage`

### Response Format Support
The implementation handles multiple response formats:
- Nested data: `{"data": {"total_usage": ..., "total_quota": ...}}`
- Flat data: `{"usage": ..., "quota": ...}`
- Alternative field names: `total_usage`, `usage`, `total_quota`, `quota`
- Custom fields: Any additional fields in the response are displayed

### Dependencies
- `aiohttp`: For async HTTP requests
- `rich`: For formatted table display
- Existing utilities: `load_config()`, `new_client_session()`

## Code Quality

All code passes:
- ✅ Ruff linting
- ✅ Ruff formatting
- ✅ Pyright type checking
- ✅ All unit tests (6/6 passing)
- ✅ No breaking changes to existing tests

## Integration

The command is automatically registered and appears in:
- `/help` command output
- Command completion
- Meta command list

No additional configuration or setup required beyond the existing Kimi CLI setup process.

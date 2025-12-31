# Config Files

Kimi CLI uses configuration files to manage API providers, models, services, and runtime parameters, supporting both TOML and JSON formats.

## Config file location

The default configuration file is located at `~/.kimi/config.toml`. On first run, if the configuration file doesn't exist, Kimi CLI will automatically create a default configuration file.

You can specify a different configuration file (TOML or JSON format) with the `--config-file` flag:

```sh
kimi --config-file /path/to/config.toml
```

When calling Kimi CLI programmatically, you can also pass the complete configuration content directly via the `--config` flag:

```sh
kimi --config '{"default_model": "kimi-for-coding", "providers": {...}, "models": {...}}'
```

## Config items

The configuration file contains the following top-level configuration items:

| Item | Type | Description |
| --- | --- | --- |
| `default_model` | `string` | Default model name, must be a model defined in `models` |
| `providers` | `table` | API provider configuration |
| `models` | `table` | Model configuration |
| `loop_control` | `table` | Agent loop control parameters |
| `services` | `table` | External service configuration (search, fetch) |
| `mcp` | `table` | MCP client configuration |

### Complete configuration example

```toml
default_model = "kimi-for-coding"

[providers.kimi-for-coding]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-xxx"

[models.kimi-for-coding]
provider = "kimi-for-coding"
model = "kimi-for-coding"
max_context_size = 262144

[loop_control]
max_steps_per_run = 100
max_retries_per_step = 3

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = "sk-xxx"

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = "sk-xxx"

[mcp.client]
tool_call_timeout_ms = 60000
```

### `providers`

`providers` defines API provider connection information. Each provider uses a unique name as key.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` | Yes | Provider type, see [Providers](./providers.md) for details |
| `base_url` | `string` | Yes | API base URL |
| `api_key` | `string` | Yes | API key |
| `env` | `table` | No | Environment variables to set before creating provider instance |
| `custom_headers` | `table` | No | Custom HTTP headers to attach to requests |

Example:

```toml
[providers.moonshot-cn]
type = "kimi"
base_url = "https://api.moonshot.cn/v1"
api_key = "sk-xxx"
custom_headers = { "X-Custom-Header" = "value" }
```

### `models`

`models` defines available models. Each model uses a unique name as key.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | `string` | Yes | Provider name to use, must be defined in `providers` |
| `model` | `string` | Yes | Model identifier (model name used in API) |
| `max_context_size` | `integer` | Yes | Maximum context length (in tokens) |
| `capabilities` | `array` | No | Model capability list, see [Providers](./providers.md#model-capabilities) for details |

Example:

```toml
[models.kimi-k2-thinking-turbo]
provider = "moonshot-cn"
model = "kimi-k2-thinking-turbo"
max_context_size = 262144
capabilities = ["thinking", "image_in"]
```

### `loop_control`

`loop_control` controls agent execution loop behavior.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_steps_per_run` | `integer` | `100` | Maximum steps per run |
| `max_retries_per_step` | `integer` | `3` | Maximum retries per step |

### `services`

`services` configures external services used by Kimi CLI.

#### `moonshot_search`

Configures web search service. When enabled, the `SearchWeb` tool becomes available.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `base_url` | `string` | Yes | Search service API URL |
| `api_key` | `string` | Yes | API key |
| `custom_headers` | `table` | No | Custom HTTP headers to attach to requests |

#### `moonshot_fetch`

Configures web fetch service. When enabled, the `FetchURL` tool prioritizes using this service to fetch webpage content.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `base_url` | `string` | Yes | Fetch service API URL |
| `api_key` | `string` | Yes | API key |
| `custom_headers` | `table` | No | Custom HTTP headers to attach to requests |

::: tip
When configuring the Kimi for Coding platform using the `/setup` command, search and fetch services are automatically configured.
:::

### `mcp`

`mcp` configures MCP client behavior.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `client.tool_call_timeout_ms` | `integer` | `60000` | MCP tool call timeout (milliseconds) |

## JSON configuration migration

If `~/.kimi/config.toml` doesn't exist but `~/.kimi/config.json` exists, Kimi CLI will automatically migrate the JSON configuration to TOML format and backup the original file as `config.json.bak`.

Configuration files specified via `--config-file` are parsed based on file extension. Configuration content passed via `--config` is first attempted as JSON, then falls back to TOML if that fails.

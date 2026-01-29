# Config Files

Kimi Code CLI uses configuration files to manage API providers, models, services, and runtime parameters, supporting both TOML and JSON formats.

## Config file location

The default configuration file is located at `~/.kimi/config.toml`. On first run, if the configuration file doesn't exist, Kimi Code CLI will automatically create a default configuration file.

You can specify a different configuration file (TOML or JSON format) with the `--config-file` flag:

```sh
kimi --config-file /path/to/config.toml
```

When calling Kimi Code CLI programmatically, you can also pass the complete configuration content directly via the `--config` flag:

```sh
kimi --config '{"default_model": "kimi-for-coding", "providers": {...}, "models": {...}}'
```

## Config items

The configuration file contains the following top-level configuration items:

| Item | Type | Description |
| --- | --- | --- |
| `default_model` | `string` | Default model name, must be a model defined in `models` |
| `default_thinking` | `boolean` | Whether to enable thinking mode by default (defaults to `false`) |
| `providers` | `table` | API provider configuration |
| `models` | `table` | Model configuration |
| `loop_control` | `table` | Agent loop control parameters |
| `services` | `table` | External service configuration (search, fetch) |
| `mcp` | `table` | MCP client configuration |

### Complete configuration example

```toml
default_model = "kimi-for-coding"
default_thinking = false

[providers.kimi-for-coding]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-xxx"

[models.kimi-for-coding]
provider = "kimi-for-coding"
model = "kimi-for-coding"
max_context_size = 262144

[loop_control]
max_steps_per_turn = 100
max_retries_per_step = 3
max_ralph_iterations = 0
reserved_context_size = 50000

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
| `max_steps_per_turn` | `integer` | `100` | Maximum steps per turn (alias: `max_steps_per_run`) |
| `max_retries_per_step` | `integer` | `3` | Maximum retries per step |
| `max_ralph_iterations` | `integer` | `0` | Extra iterations after each user message; `0` disables; `-1` is unlimited |
| `reserved_context_size` | `integer` | `50000` | Reserved token count for LLM response generation; auto-compaction triggers when `context_tokens + reserved_context_size >= max_context_size` |

### `services`

`services` configures external services used by Kimi Code CLI.

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
When configuring the Kimi Code platform using the `/setup` command, search and fetch services are automatically configured.
:::

### `mcp`

`mcp` configures MCP client behavior.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `client.tool_call_timeout_ms` | `integer` | `60000` | MCP tool call timeout (milliseconds) |

## JSON configuration migration

If `~/.kimi/config.toml` doesn't exist but `~/.kimi/config.json` exists, Kimi Code CLI will automatically migrate the JSON configuration to TOML format and backup the original file as `config.json.bak`.

`--config-file` specified configuration files are parsed based on file extension. `--config` passed configuration content is first attempted as JSON, then falls back to TOML if that fails.

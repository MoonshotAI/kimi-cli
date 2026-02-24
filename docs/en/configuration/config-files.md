# Config files

Kimi Code CLI uses configuration files to manage API providers, models, services, and runtime parameters. Both TOML and JSON formats are supported.

## Configuration file location

The default configuration file is located at `~/.kimi/config.toml`. On the first run, if the configuration file does not exist, Kimi Code CLI will automatically create a default configuration file.

You can specify a different configuration file (either TOML or JSON format) using the `--config-file` parameter:

```sh
kimi --config-file /path/to/config.toml
```

When calling Kimi Code CLI programmatically, you can also pass the complete configuration content directly via the `--config` parameter:

```sh
kimi --config '{"default_model": "kimi-for-coding", "providers": {...}, "models": {...}}'
```

## Configuration options

The configuration file contains the following top-level configuration options:

| Configuration Option | Type | Description |
| --- | --- | --- |
| `default_model` | `string` | The default model name to use; must be a model defined in `models` |
| `default_thinking` | `boolean` | Whether to enable thinking mode by default (default is `false`) |
| `default_yolo` | `boolean` | Whether to enable YOLO (auto-approval) mode by default (default is `false`) |
| `bell_on_completion` | `boolean` | Whether to play a notification sound when an agent turn completes (default is `true`) |
| `providers` | `table` | API provider configuration |
| `models` | `table` | Model configuration |
| `loop_control` | `table` | Agent loop control parameters |
| `services` | `table` | External service configuration (search, fetch) |
| `mcp` | `table` | MCP client configuration |

### Complete configuration example

```toml
default_model = "kimi-for-coding"
default_thinking = false
default_yolo = false
bell_on_completion = true

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

`providers` defines API provider connection information. Each provider uses a unique name as the key.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` | Yes | Provider type; see [Platforms and models](./providers.md) for details |
| `base_url` | `string` | Yes | API base URL |
| `api_key` | `string` | Yes | API key |
| `env` | `table` | No | Environment variables to set before creating the provider instance |
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

`models` defines the available models. Each model uses a unique name as the key.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | `string` | Yes | The provider name to use; must be defined in `providers` |
| `model` | `string` | Yes | Model identifier (the model name used in the API) |
| `max_context_size` | `integer` | Yes | Maximum context length (in tokens) |
| `capabilities` | `array` | No | List of model capabilities; see [Platforms and models](./providers.md#model-capabilities) for details |

Example:

```toml
[models.kimi-k2-thinking-turbo]
provider = "moonshot-cn"
model = "kimi-k2-thinking-turbo"
max_context_size = 262144
capabilities = ["thinking", "image_in"]
```

### `loop_control`

`loop_control` controls the behavior of the agent execution loop.

| Field | Type | Default Value | Description |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | `100` | Maximum steps per turn (alias: `max_steps_per_run`) |
| `max_retries_per_step` | `integer` | `3` | Maximum retries per step |
| `max_ralph_iterations` | `integer` | `0` | Additional automatic iterations after each user message; `0` means disabled; `-1` means infinite |
| `reserved_context_size` | `integer` | `50000` | Number of tokens reserved for LLM response generation; automatic compaction is triggered when `context_tokens + reserved_context_size >= max_context_size` |

### `services`

`services` configures the external services used by Kimi Code CLI.

#### `moonshot_search`

Configures the web search service. When enabled, the `SearchWeb` tool becomes available.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `base_url` | `string` | Yes | Search service API URL |
| `api_key` | `string` | Yes | API key |
| `custom_headers` | `table` | No | Custom HTTP headers to attach to requests |

#### `moonshot_fetch`

Configures the web fetch service. When enabled, the `FetchURL` tool will prioritize using this service to fetch web page content.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `base_url` | `string` | Yes | Fetch service API URL |
| `api_key` | `string` | Yes | API key |
| `custom_headers` | `table` | No | Custom HTTP headers to attach to requests |

::: tip Tip
When configuring the Kimi Code platform using the `/login` command, the search and fetch services will be automatically configured.
:::

### `mcp`

`mcp` configures MCP client behavior.

| Field | Type | Default Value | Description |
| --- | --- | --- | --- |
| `client.tool_call_timeout_ms` | `integer` | `60000` | MCP tool call timeout (in milliseconds) |

## JSON configuration migration

If `~/.kimi/config.toml` does not exist but `~/.kimi/config.json` exists, Kimi Code CLI will automatically migrate the JSON configuration to TOML format and back up the original file as `config.json.bak`.

The configuration file specified by `--config-file` is parsed automatically based on its extension. Configuration content passed via `--config` is first attempted to be parsed as JSON, and if that fails, it will be parsed as TOML.

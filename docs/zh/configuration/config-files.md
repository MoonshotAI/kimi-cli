# 配置文件

Kimi Code CLI 使用配置文件管理 API 供应商、模型、服务和运行参数，支持 TOML 和 JSON 两种格式。

## 配置文件位置

默认配置文件位于 `~/.kimi/config.toml`。首次运行时，如果配置文件不存在，Kimi Code CLI 会自动创建一个默认的配置文件。

你可以通过 `--config-file` 参数指定其他配置文件（TOML 或 JSON 格式均可）：

```sh
kimi --config-file /path/to/config.toml
```

在程序化调用 Kimi Code CLI 时，也可以通过 `--config` 参数直接传入完整的配置内容：

```sh
kimi --config '{"default_model": "kimi-for-coding", "providers": {...}, "models": {...}}'
```

## 配置项

配置文件包含以下顶层配置项：

| 配置项 | 类型 | 说明 |
| --- | --- | --- |
| `default_model` | `string` | 默认使用的模型名称，必须是 `models` 中定义的模型 |
| `default_thinking` | `boolean` | 默认是否开启 Thinking 模式（默认为 `false`） |
| `default_yolo` | `boolean` | 默认是否开启 YOLO（自动审批）模式（默认为 `false`） |
| `providers` | `table` | API 供应商配置 |
| `models` | `table` | 模型配置 |
| `loop_control` | `table` | Agent 循环控制参数 |
| `services` | `table` | 外部服务配置（搜索、抓取） |
| `mcp` | `table` | MCP 客户端配置 |

### 完整配置示例

```toml
default_model = "kimi-for-coding"
default_thinking = false
default_yolo = false

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

`providers` 定义 API 供应商连接信息。每个供应商使用一个唯一的名称作为 key。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` | 是 | 供应商类型，详见 [平台与模型](./providers.md) |
| `base_url` | `string` | 是 | API 基础 URL |
| `api_key` | `string` | 是 | API 密钥 |
| `env` | `table` | 否 | 创建供应商实例前设置的环境变量 |
| `custom_headers` | `table` | 否 | 请求时附加的自定义 HTTP 头 |

示例：

```toml
[providers.moonshot-cn]
type = "kimi"
base_url = "https://api.moonshot.cn/v1"
api_key = "sk-xxx"
custom_headers = { "X-Custom-Header" = "value" }
```

### `models`

`models` 定义可用的模型。每个模型使用一个唯一的名称作为 key。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider` | `string` | 是 | 使用的供应商名称，必须在 `providers` 中定义 |
| `model` | `string` | 是 | 模型标识符（API 中使用的模型名称） |
| `max_context_size` | `integer` | 是 | 最大上下文长度（token 数） |
| `capabilities` | `array` | 否 | 模型能力列表，详见 [平台与模型](./providers.md#模型能力) |

示例：

```toml
[models.kimi-k2-thinking-turbo]
provider = "moonshot-cn"
model = "kimi-k2-thinking-turbo"
max_context_size = 262144
capabilities = ["thinking", "image_in"]
```

### `loop_control`

`loop_control` 控制 Agent 执行循环的行为。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | `100` | 单轮最大步数（别名：`max_steps_per_run`） |
| `max_retries_per_step` | `integer` | `3` | 单步最大重试次数 |
| `max_ralph_iterations` | `integer` | `0` | 每个 User 消息后额外自动迭代次数；`0` 表示关闭；`-1` 表示无限 |
| `reserved_context_size` | `integer` | `50000` | 预留给 LLM 响应生成的 token 数量；当 `context_tokens + reserved_context_size >= max_context_size` 时自动触发压缩 |

### `services`

`services` 配置 Kimi Code CLI 使用的外部服务。

#### `moonshot_search`

配置网页搜索服务，启用后 `SearchWeb` 工具可用。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `base_url` | `string` | 是 | 搜索服务 API URL |
| `api_key` | `string` | 是 | API 密钥 |
| `custom_headers` | `table` | 否 | 请求时附加的自定义 HTTP 头 |

#### `moonshot_fetch`

配置网页抓取服务，启用后 `FetchURL` 工具优先使用此服务抓取网页内容。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `base_url` | `string` | 是 | 抓取服务 API URL |
| `api_key` | `string` | 是 | API 密钥 |
| `custom_headers` | `table` | 否 | 请求时附加的自定义 HTTP 头 |

::: tip 提示
使用 `/login` 命令配置 Kimi Code 平台时，搜索和抓取服务会自动配置。
:::

### `mcp`

`mcp` 配置 MCP 客户端行为。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `client.tool_call_timeout_ms` | `integer` | `60000` | MCP 工具调用超时时间（毫秒） |

## JSON 配置迁移

如果 `~/.kimi/config.toml` 不存在但 `~/.kimi/config.json` 存在，Kimi Code CLI 会自动将 JSON 配置迁移到 TOML 格式，并将原文件备份为 `config.json.bak`。

`--config-file` 指定的配置文件根据扩展名自动选择解析方式。`--config` 传入的配置内容会先尝试按 JSON 解析，失败后再尝试 TOML。

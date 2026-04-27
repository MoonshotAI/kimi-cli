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
| `default_plan_mode` | `boolean` | 默认是否以计划模式启动新会话（默认为 `false`）；恢复的会话保留其原有状态 |
| `default_editor` | `string` | 默认外部编辑器命令（如 `"vim"`、`"code --wait"`），为空时自动检测 |
| `theme` | `string` | 终端配色主题，可选 `"dark"` 或 `"light"`（默认为 `"dark"`） |
| `show_thinking_stream` | `boolean` | 是否在 Live 区域以 6 行滚动预览方式实时展示模型的原始思考文本，并在 thinking 块结束时把完整思考内容（Markdown）写入历史记录（默认为 `true`；设为 `false` 则仅显示紧凑的 `Thinking ...` 指示器和一行 trace 总结） |
| `merge_all_available_skills` | `boolean` | 是否合并所有品牌目录中的 Skills（默认为 `true`）；详见 [Skills 配置](../customization/skills.md) |
| `providers` | `table` | API 供应商配置 |
| `models` | `table` | 模型配置 |
| `loop_control` | `table` | Agent 循环控制参数 |
| `background` | `table` | 后台任务运行参数 |
| `services` | `table` | 外部服务配置（搜索、抓取） |
| `mcp` | `table` | MCP 客户端配置 |

### 完整配置示例

```toml
default_model = "kimi-for-coding"
default_thinking = false
default_yolo = false
default_plan_mode = false
default_editor = ""
theme = "dark"
show_thinking_stream = true
merge_all_available_skills = true

[providers.kimi-for-coding]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-xxx"

[models.kimi-for-coding]
provider = "kimi-for-coding"
model = "kimi-for-coding"
max_context_size = 262144

[loop_control]
max_steps_per_turn = 500
max_retries_per_step = 3
max_ralph_iterations = 0
reserved_context_size = 50000
compaction_trigger_ratio = 0.85

[background]
max_running_tasks = 4
keep_alive_on_exit = false
agent_task_timeout_s = 900

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

::: warning 注意
如果 `providers` 或 `models` 的 key 中包含 `.`，必须使用带引号的 TOML key。否则 TOML 会把 `.` 当作路径分隔符，将 key 解析为嵌套表。
:::

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider` | `string` | 是 | 使用的供应商名称，必须在 `providers` 中定义 |
| `model` | `string` | 是 | 模型标识符（API 中使用的模型名称） |
| `max_context_size` | `integer` | 是 | 最大上下文长度（token 数） |
| `capabilities` | `array` | 否 | 模型能力列表，详见 [平台与模型](./providers.md#模型能力) |
| `display_name` | `string` | 否 | 模型展示名。在欢迎界面、提示框状态栏、`/model` 选单和切换确认消息中显示；未设置时回落到 `model`。对于 OAuth 登录的托管模型，启动时会从供应商的 `/models` 接口自动刷新此字段 |

示例：

```toml
[models.kimi-k2-thinking-turbo]
provider = "moonshot-cn"
model = "kimi-k2-thinking-turbo"
max_context_size = 262144
capabilities = ["thinking", "image_in"]
```

如果模型名包含 `.`，需要使用带引号的 key：

```toml
[models."gpt-4.1"]
provider = "openai"
model = "gpt-4.1"
max_context_size = 1047576
capabilities = ["thinking"]
```

### `loop_control`

`loop_control` 控制 Agent 执行循环的行为。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | `500` | 单轮最大步数（别名：`max_steps_per_run`） |
| `max_retries_per_step` | `integer` | `3` | 单步最大重试次数 |
| `max_ralph_iterations` | `integer` | `0` | 每个 User 消息后额外自动迭代次数；`0` 表示关闭；`-1` 表示无限 |
| `reserved_context_size` | `integer` | `50000` | 预留给 LLM 响应生成的 token 数量；当 `context_tokens + reserved_context_size >= max_context_size` 时自动触发压缩 |
| `compaction_trigger_ratio` | `float` | `0.85` | 触发自动压缩的上下文使用率阈值（0.5–0.99）；当 `context_tokens >= max_context_size * compaction_trigger_ratio` 时自动触发压缩，与 `reserved_context_size` 条件取先触发者 |

### `background`

`background` 控制后台任务的运行行为。后台任务通过 `Shell` 工具的 `run_in_background=true` 或 `Agent` 工具的 `run_in_background=true` 参数启动。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_running_tasks` | `integer` | `4` | 同时运行的最大后台任务数 |
| `keep_alive_on_exit` | `boolean` | `false` | CLI 退出时是否保留后台任务运行；默认退出时终止所有后台任务 |
| `kill_grace_period_ms` | `integer` | `2000` | CLI 退出发送 SIGTERM 后等待 shell worker 写入终态的宽限期（毫秒），超过后仍未退出的 worker 会被报告为残留。Agent 任务在 kill 时直接同步转为终态，不使用这个 grace period |
| `agent_task_timeout_s` | `integer` | `900` | 后台 Agent 任务的最大运行时间（秒）；超时后任务标记为失败并通知主 Agent |
| `print_wait_ceiling_s` | `integer` | `3600` | 一次性 `--print` 模式等待后台任务完成的硬上限（秒），超时则 kill 并退出。实际等待时间为"当前活跃任务中剩余预算最长的那个"，被此上限封顶 |

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

### `hooks`

`hooks` 配置生命周期 hook（Beta 功能）。详见 [Hooks](../customization/hooks.md)。

使用 `[[hooks]]` 数组语法定义多个 hook：

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = ".kimi/hooks/safety-check.sh"
timeout = 10

[[hooks]]
event = "PostToolUse"
matcher = "WriteFile"
command = "prettier --write"
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `event` | `string` | 是 | 事件类型，如 `PreToolUse`、`Stop` 等 |
| `command` | `string` | 是 | 要执行的 shell 命令 |
| `matcher` | `string` | 否 | 正则表达式过滤条件 |
| `timeout` | `integer` | 否 | 超时时间（秒），默认 30 |

## JSON 配置迁移

如果 `~/.kimi/config.toml` 不存在但 `~/.kimi/config.json` 存在，Kimi Code CLI 会自动将 JSON 配置迁移到 TOML 格式，并将原文件备份为 `config.json.bak`。

`--config-file` 指定的配置文件根据扩展名自动选择解析方式。`--config` 传入的配置内容会先尝试按 JSON 解析，失败后再尝试 TOML。

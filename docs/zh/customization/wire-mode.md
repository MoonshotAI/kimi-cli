# Wire 模式

Wire 模式是 Kimi Code CLI 的底层通信协议，用于与外部程序进行结构化的双向通信。

## Wire 是什么

Wire 是 Kimi Code CLI 内部使用的消息传递层。当你使用终端交互时，Shell UI 通过 Wire 接收 AI 的输出并显示；当你使用 ACP 集成到 IDE 时，ACP 服务器也通过 Wire 与 Agent 核心通信。

Wire 模式（`--wire`）将这个通信协议暴露出来，允许外部程序直接与 Kimi Code CLI 交互。这适用于构建自定义 UI 或将 Kimi Code CLI 嵌入到其他应用中。

```sh
kimi --wire
```

## 使用场景

Wire 模式主要用于：

- **自定义 UI**：构建 Web、桌面或移动端的 Kimi Code CLI 前端
- **应用集成**：将 Kimi Code CLI 嵌入到其他应用程序中
- **自动化测试**：对 Agent 行为进行程序化测试

::: tip 提示
如果你只需要简单的非交互输入输出，使用 [Print 模式](./print-mode.md) 更简单。Wire 模式适合需要完整控制和双向通信的场景。
:::

## Wire 协议

Wire 使用基于 JSON-RPC 2.0 的协议，通过 stdin/stdout 进行双向通信。当前协议版本为 `1.2`。每条消息是一行 JSON，符合 JSON-RPC 2.0 规范。

### 协议类型定义

```typescript
/** JSON-RPC 2.0 请求消息基础结构 */
interface JSONRPCRequest<Method extends string, Params> {
  jsonrpc: "2.0"
  method: Method
  id: string
  params: Params
}

/** JSON-RPC 2.0 通知消息（无 id，无需响应） */
interface JSONRPCNotification<Method extends string, Params> {
  jsonrpc: "2.0"
  method: Method
  params: Params
}

/** JSON-RPC 2.0 成功响应 */
interface JSONRPCSuccessResponse<Result> {
  jsonrpc: "2.0"
  id: string
  result: Result
}

/** JSON-RPC 2.0 错误响应 */
interface JSONRPCErrorResponse {
  jsonrpc: "2.0"
  id: string
  error: JSONRPCError
}

interface JSONRPCError {
  code: number
  message: string
  data?: unknown
}
```

### `initialize`

::: info 新增
新增于 Wire 1.1。旧版 Client 可跳过此请求，直接发送 `prompt`。
:::

- **方向**：Client → Agent
- **类型**：Request（需要响应）

可选握手请求，用于协商协议版本、提交外部工具定义并获取斜杠命令列表。

```typescript
/** initialize 请求参数 */
interface InitializeParams {
  /** 协议版本 */
  protocol_version: string
  /** Client 信息，可选 */
  client?: ClientInfo
  /** 外部工具定义列表，可选 */
  external_tools?: ExternalTool[]
}

interface ClientInfo {
  name: string
  version?: string
}

interface ExternalTool {
  /** 工具名称，不可与内置工具冲突 */
  name: string
  /** 工具描述 */
  description: string
  /** JSON Schema 格式的参数定义 */
  parameters: JSONSchema
}

/** initialize 响应结果 */
interface InitializeResult {
  /** 协议版本 */
  protocol_version: string
  /** Server 信息 */
  server: ServerInfo
  /** 可用的斜杠命令列表 */
  slash_commands: SlashCommandInfo[]
  /** 外部工具注册结果，仅当请求中包含 external_tools 时返回 */
  external_tools?: ExternalToolsResult
}

interface ServerInfo {
  name: string
  version: string
}

interface SlashCommandInfo {
  name: string
  description: string
  aliases: string[]
}

interface ExternalToolsResult {
  /** 成功注册的工具名称列表 */
  accepted: string[]
  /** 注册失败的工具及原因 */
  rejected: Array<{ name: string; reason: string }>
}
```

**请求示例**

```json
{"jsonrpc": "2.0", "method": "initialize", "id": "550e8400-e29b-41d4-a716-446655440000", "params": {"protocol_version": "1.1", "client": {"name": "my-ui", "version": "1.0.0"}, "external_tools": [{"name": "open_in_ide", "description": "Open file in IDE", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}]}}
```

**成功响应示例**

```json
{"jsonrpc": "2.0", "id": "550e8400-e29b-41d4-a716-446655440000", "result": {"protocol_version": "1.1", "server": {"name": "Kimi Code CLI", "version": "0.69.0"}, "slash_commands": [{"name": "init", "description": "Analyze the codebase ...", "aliases": []}], "external_tools": {"accepted": ["open_in_ide"], "rejected": []}}}
```

若 Server 不支持 `initialize` 方法，Client 会收到 `-32601 method not found` 错误，应自动降级到无握手模式。

### `prompt`

- **方向**：Client → Agent
- **类型**：Request（需要响应）

发送用户输入并运行 Agent 轮次。调用后 Agent 开始处理，期间会发送 `event` 通知和 `request` 请求，直到轮次完成才返回响应。

```typescript
/** prompt 请求参数 */
interface PromptParams {
  /** 用户输入，可以是纯文本或内容片段数组 */
  user_input: string | ContentPart[]
}

/** prompt 响应结果 */
interface PromptResult {
  /** 轮次结束状态 */
  status: "finished" | "cancelled" | "max_steps_reached"
  /** 当 status 为 max_steps_reached 时，包含已执行的步数 */
  steps?: number
}
```

**请求示例**

```json
{"jsonrpc": "2.0", "method": "prompt", "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "params": {"user_input": "你好"}}
```

**成功响应示例**

```json
{"jsonrpc": "2.0", "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "result": {"status": "finished"}}
```

**错误响应示例**

```json
{"jsonrpc": "2.0", "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "error": {"code": -32001, "message": "LLM is not set"}}
```

| code | 说明 |
|------|------|
| `-32000` | 已有轮次正在进行中 |
| `-32001` | 未配置 LLM |
| `-32002` | 不支持指定的 LLM |
| `-32003` | LLM 服务错误 |

### `cancel`

- **方向**：Client → Agent
- **类型**：Request（需要响应）

取消当前正在进行的 Agent 轮次。调用后，正在进行的 `prompt` 请求会返回 `{"status": "cancelled"}`。

```typescript
/** cancel 请求无参数，params 可以是空对象或省略 */
type CancelParams = Record<string, never>

/** cancel 响应结果为空对象 */
type CancelResult = Record<string, never>
```

**请求示例**

```json
{"jsonrpc": "2.0", "method": "cancel", "id": "6ba7b811-9dad-11d1-80b4-00c04fd430c8"}
```

**成功响应示例**

```json
{"jsonrpc": "2.0", "id": "6ba7b811-9dad-11d1-80b4-00c04fd430c8", "result": {}}
```

**错误响应示例**

如果当前没有轮次在进行：

```json
{"jsonrpc": "2.0", "id": "6ba7b811-9dad-11d1-80b4-00c04fd430c8", "error": {"code": -32000, "message": "No agent turn is in progress"}}
```

### `event`

- **方向**：Agent → Client
- **类型**：Notification（无需响应）

Agent 在轮次进行过程中发出的事件通知。没有 `id` 字段，Client 无需响应。

```typescript
/** event 通知参数，包含序列化后的 Wire 消息 */
interface EventParams {
  type: string
  payload: object
}
```

**示例**

```json
{"jsonrpc": "2.0", "method": "event", "params": {"type": "ContentPart", "payload": {"type": "text", "text": "Hello"}}}
```

### `request`

- **方向**：Agent → Client
- **类型**：Request（需要响应）

Agent 向 Client 发出的请求，用于审批确认或外部工具调用。Client 必须响应后 Agent 才能继续执行。

```typescript
/** request 请求参数，包含序列化后的 Wire 消息 */
interface RequestParams {
  type: "ApprovalRequest" | "ToolCallRequest"
  payload: ApprovalRequest | ToolCallRequest
}
```

**审批请求示例**

```json
{"jsonrpc": "2.0", "method": "request", "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "params": {"type": "ApprovalRequest", "payload": {"id": "approval-1", "tool_call_id": "tc-1", "sender": "Shell", "action": "run shell command", "description": "Run command `ls`", "display": []}}}
```

**审批响应示例**

```json
{"jsonrpc": "2.0", "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "result": {"request_id": "approval-1", "response": "approve"}}
```

**外部工具调用请求示例**

```json
{"jsonrpc": "2.0", "method": "request", "id": "a3bb189e-8bf9-3888-9912-ace4e6543002", "params": {"type": "ToolCallRequest", "payload": {"id": "tc-1", "name": "open_in_ide", "arguments": "{\"path\":\"README.md\"}"}}}
```

**外部工具调用响应示例**

```json
{"jsonrpc": "2.0", "id": "a3bb189e-8bf9-3888-9912-ace4e6543002", "result": {"tool_call_id": "tc-1", "return_value": {"is_error": false, "output": "Opened", "message": "Opened README.md in IDE", "display": []}}}
```

### 标准错误码

所有请求都可能返回 JSON-RPC 2.0 标准错误：

| code | 说明 |
|------|------|
| `-32700` | 无效的 JSON 格式 |
| `-32600` | 无效的请求（如缺少必要字段） |
| `-32601` | 方法不存在 |
| `-32602` | 无效的方法参数 |
| `-32603` | 内部错误 |

## Wire 消息类型

Wire 消息通过 `event` 和 `request` 方法传递，格式为 `{"type": "...", "payload": {...}}`。以下使用 TypeScript 风格的类型定义描述所有消息类型。

```typescript
/** 所有 Wire 消息的联合类型 */
type WireMessage = Event | Request

/** 事件：通过 event 方法发送，无需响应 */
type Event =
  | TurnBegin
  | TurnEnd
  | StepBegin
  | StepInterrupted
  | CompactionBegin
  | CompactionEnd
  | StatusUpdate
  | ContentPart
  | ToolCall
  | ToolCallPart
  | ToolResult
  | ApprovalResponse
  | SubagentEvent

/** 请求：通过 request 方法发送，需要响应 */
type Request = ApprovalRequest | ToolCallRequest
```

### `TurnBegin`

轮次开始。

```typescript
interface TurnBegin {
  /** 用户输入，可以是纯文本或内容片段数组 */
  user_input: string | ContentPart[]
}
```

### `TurnEnd`

::: info 新增
新增于 Wire 1.2。
:::

轮次结束。此事件在轮次的所有其他事件之后发送。如果轮次被中断，此事件可能不会发送。

```typescript
interface TurnEnd {
  // 无额外字段
}
```

### `StepBegin`

步骤开始。

```typescript
interface StepBegin {
  /** 步骤编号，从 1 开始 */
  n: number
}
```

### `StepInterrupted`

步骤被中断，无额外字段。

### `CompactionBegin`

上下文压缩开始，无额外字段。

### `CompactionEnd`

上下文压缩结束，无额外字段。

### `StatusUpdate`

状态更新。

```typescript
interface StatusUpdate {
  /** 上下文使用率，0-1 之间的浮点数，JSON 中可能不存在 */
  context_usage?: number | null
  /** 当前步骤的 token 用量统计，JSON 中可能不存在 */
  token_usage?: TokenUsage | null
  /** 当前步骤的消息 ID，JSON 中可能不存在 */
  message_id?: string | null
}

interface TokenUsage {
  /** 不包括 input_cache_read 和 input_cache_creation 的输入 token 数 */
  input_other: number
  /** 总输出 token 数 */
  output: number
  /** 缓存的输入 token 数 */
  input_cache_read: number
  /** 用于缓存创建的输入 token 数，目前仅 Anthropic API 支持此字段 */
  input_cache_creation: number
}
```

### `ContentPart`

消息内容片段。序列化时 `type` 为 `"ContentPart"`，具体类型由 `payload.type` 区分。

```typescript
type ContentPart =
  | TextPart
  | ThinkPart
  | ImageURLPart
  | AudioURLPart
  | VideoURLPart

interface TextPart {
  type: "text"
  /** 文本内容 */
  text: string
}

interface ThinkPart {
  type: "think"
  /** 思考内容 */
  think: string
  /** 加密的思考内容或签名，JSON 中可能不存在 */
  encrypted?: string | null
}

interface ImageURLPart {
  type: "image_url"
  image_url: {
    /** 图片 URL，可以是 data URI（如 data:image/png;base64,...） */
    url: string
    /** 图片 ID，用于区分不同图片，JSON 中可能不存在 */
    id?: string | null
  }
}

interface AudioURLPart {
  type: "audio_url"
  audio_url: {
    /** 音频 URL，可以是 data URI（如 data:audio/aac;base64,...） */
    url: string
    /** 音频 ID，用于区分不同音频，JSON 中可能不存在 */
    id?: string | null
  }
}

interface VideoURLPart {
  type: "video_url"
  video_url: {
    /** 视频 URL，可以是 data URI（如 data:video/mp4;base64,...） */
    url: string
    /** 视频 ID，用于区分不同视频，JSON 中可能不存在 */
    id?: string | null
  }
}
```

### `ToolCall`

工具调用。

```typescript
interface ToolCall {
  /** 固定为 "function" */
  type: "function"
  /** 工具调用 ID */
  id: string
  function: {
    /** 工具名称 */
    name: string
    /** JSON 格式的参数字符串，JSON 中可能不存在 */
    arguments?: string | null
  }
  /** 额外信息，JSON 中可能不存在 */
  extras?: object | null
}
```

### `ToolCallPart`

工具调用参数片段（流式）。

```typescript
interface ToolCallPart {
  /** 参数片段，用于流式传输工具调用参数，JSON 中可能不存在 */
  arguments_part?: string | null
}
```

### `ToolResult`

工具执行结果。

```typescript
interface ToolResult {
  /** 对应的工具调用 ID */
  tool_call_id: string
  return_value: ToolReturnValue
}

interface ToolReturnValue {
  /** 是否为错误 */
  is_error: boolean
  /** 返回给模型的输出内容 */
  output: string | ContentPart[]
  /** 给模型的解释性消息 */
  message: string
  /** 显示给用户的内容块 */
  display: DisplayBlock[]
  /** 额外调试信息，JSON 中可能不存在 */
  extras?: object | null
}
```

### `ApprovalResponse`

::: info 变更
重命名于 Wire 1.1。原名 `ApprovalRequestResolved`，旧名称仍可使用以保持向后兼容。
:::

审批响应事件，表示审批请求已完成。

```typescript
interface ApprovalResponse {
  /** 审批请求 ID */
  request_id: string
  /** 审批结果 */
  response: "approve" | "approve_for_session" | "reject"
}
```

### `SubagentEvent`

子 Agent 事件。

```typescript
interface SubagentEvent {
  /** 关联的 Task 工具调用 ID */
  task_tool_call_id: string
  /** 子 Agent 产生的事件，嵌套的 Wire 消息格式 */
  event: { type: string; payload: object }
}
```

### `ApprovalRequest`

审批请求，通过 `request` 方法发送，Client 必须响应后 Agent 才能继续。

```typescript
interface ApprovalRequest {
  /** 请求 ID，用于响应时引用 */
  id: string
  /** 关联的工具调用 ID */
  tool_call_id: string
  /** 发起者（工具名称） */
  sender: string
  /** 操作描述 */
  action: string
  /** 详细说明 */
  description: string
  /** 显示给用户的内容块，JSON 中可能不存在，默认为 [] */
  display?: DisplayBlock[]
}
```

**响应格式**

Client 需要返回 `ApprovalResponse` 作为响应结果：

```typescript
interface ApprovalResponse {
  request_id: string
  response: "approve" | "approve_for_session" | "reject"
}
```

| response | 说明 |
|----------|------|
| `approve` | 批准本次操作 |
| `approve_for_session` | 批准本会话中的同类操作 |
| `reject` | 拒绝操作 |

### `ToolCallRequest`

外部工具调用请求，通过 `request` 方法发送。当 Agent 调用 `initialize` 时注册的外部工具时，会发送此请求。Client 必须执行工具并返回 `ToolResult`。

```typescript
interface ToolCallRequest {
  /** 工具调用 ID */
  id: string
  /** 工具名称 */
  name: string
  /** JSON 格式的参数字符串，JSON 中可能不存在 */
  arguments?: string | null
}
```

**响应格式**

Client 需要返回 `ToolResult` 作为响应结果：

```typescript
interface ToolResult {
  tool_call_id: string
  return_value: ToolReturnValue
}
```

### `DisplayBlock`

`ToolResult` 和 `ApprovalRequest` 的 `display` 字段使用的显示块类型。

```typescript
type DisplayBlock =
  | UnknownDisplayBlock
  | BriefDisplayBlock
  | DiffDisplayBlock
  | TodoDisplayBlock
  | ShellDisplayBlock

/** 无法识别的显示块类型的 fallback */
interface UnknownDisplayBlock {
  /** 任意类型标识 */
  type: string
  /** 原始数据 */
  data: object
}

interface BriefDisplayBlock {
  type: "brief"
  /** 简短的文本内容 */
  text: string
}

interface DiffDisplayBlock {
  type: "diff"
  /** 文件路径 */
  path: string
  /** 原始内容 */
  old_text: string
  /** 新内容 */
  new_text: string
}

interface TodoDisplayBlock {
  type: "todo"
  /** 待办事项列表 */
  items: TodoDisplayItem[]
}

interface TodoDisplayItem {
  /** 待办事项标题 */
  title: string
  /** 状态 */
  status: "pending" | "in_progress" | "done"
}

interface ShellDisplayBlock {
  type: "shell"
  /** 语法高亮的语言标识（如 "sh"、"powershell"） */
  language: string
  /** Shell 命令内容 */
  command: string
}
```

## Kimi Agent（Rust）Wire Server

::: warning 注意
Kimi Agent 目前为实验性功能，API 和行为可能在后续版本中发生变化。
:::

Kimi Agent (Rust) 是 Kimi Code CLI 内核的 Rust 实现，专为 Wire 模式设计。如果你只需要 Wire 协议服务，Kimi Agent (Rust) 提供了一个更轻量的选择。Rust 实现位于 [`MoonshotAI/kimi-agent-rs`](https://github.com/MoonshotAI/kimi-agent-rs)。

### 特点

- **Wire 协议完全兼容**：与 Python 版 `kimi --wire` 使用相同的 Wire 协议，现有客户端无需修改
- **更小的体积**：单一静态链接二进制，无需 Python 运行时
- **更快的启动**：原生编译，启动速度更快
- **相同的配置**：使用相同的配置文件（`~/.kimi/config.toml`）和会话目录

### 限制

- **仅支持 Wire 模式**：没有 Shell/Print/ACP UI
- **仅支持 Kimi 供应商**：不支持 OpenAI、Anthropic 等其他供应商
- **无 Kimi 账号登录功能**：没有 `login`/`logout` 子命令和 `/login`、`/logout` 斜杠命令，需要手动配置 API 密钥
- **不支持 `--prompt`/`--command`**：Wire 服务器不接受初始提示词
- **仅支持本地执行**：没有 SSH Kaos 支持
- **MCP OAuth 存储位置不同**：Kimi Agent 存储在 `~/.kimi/credentials/mcp_auth.json`，Python 版存储在 `~/.fastmcp/oauth-mcp-client-cache/`，两者不兼容

### 安装

从 [GitHub Releases](https://github.com/MoonshotAI/kimi-agent-rs/releases) 下载预编译的二进制文件：

```sh
# macOS (Apple Silicon)
curl -L https://github.com/MoonshotAI/kimi-agent-rs/releases/latest/download/kimi-agent-aarch64-apple-darwin.tar.gz | tar xz
sudo mv kimi-agent /usr/local/bin/

# Linux (x86_64)
curl -L https://github.com/MoonshotAI/kimi-agent-rs/releases/latest/download/kimi-agent-x86_64-unknown-linux-gnu.tar.gz | tar xz
sudo mv kimi-agent /usr/local/bin/
```

### 使用

Kimi Agent 默认运行 Wire 模式：

```sh
kimi-agent
```

常用选项与 `kimi` 命令相同：

```sh
# 指定工作目录
kimi-agent --work-dir /path/to/project

# 继续上一个会话
kimi-agent --continue

# 使用指定会话
kimi-agent --session <session-id>

# 使用指定模型
kimi-agent --model k2

# YOLO 模式（跳过审批）
kimi-agent --yolo
```

子命令：

```sh
# 显示版本和环境信息
kimi-agent info

# 管理 MCP 服务器
kimi-agent mcp list
kimi-agent mcp add <name> <command> [args...]
kimi-agent mcp remove <name>
```

### 版本同步

Kimi Agent 与 Kimi Code CLI 独立发版。兼容性与同步状态以 `MoonshotAI/kimi-agent-rs` 的发布说明为准。

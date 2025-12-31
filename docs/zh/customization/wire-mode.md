# Wire 模式

Wire 模式是 Kimi CLI 的底层通信协议，用于与外部程序进行结构化的双向通信。

## Wire 是什么

Wire 是 Kimi CLI 内部使用的消息传递层。当你使用终端交互时，Shell UI 通过 Wire 接收 AI 的输出并显示；当你使用 ACP 集成到 IDE 时，ACP 服务器也通过 Wire 与 Agent 核心通信。

Wire 模式（`--wire`）将这个通信协议暴露出来，允许外部程序直接与 Kimi CLI 交互。这适用于构建自定义 UI 或将 Kimi CLI 嵌入到其他应用中。

```sh
kimi --wire
```

## 使用场景

Wire 模式主要用于：

- **自定义 UI**：构建 Web、桌面或移动端的 Kimi CLI 前端
- **应用集成**：将 Kimi CLI 嵌入到其他应用程序中
- **自动化测试**：对 Agent 行为进行程序化测试

::: tip 提示
如果你只需要简单的非交互输入输出，使用 [Print 模式](./print-mode.md) 更简单。Wire 模式适合需要完整控制和双向通信的场景。
:::

## Wire 协议

Wire 使用基于 JSON-RPC 2.0 的协议，通过 stdin/stdout 进行双向通信。

**消息格式**

每条消息是一行 JSON，符合 JSON-RPC 2.0 规范：

```json
{"jsonrpc": "2.0", "method": "...", "params": {...}}
```

### `prompt`

- **方向**：Client → Agent
- **类型**：Request（需要响应）

发送用户输入并运行 Agent 轮次。调用后 Agent 开始处理，直到轮次完成才返回响应。

```json
{"jsonrpc": "2.0", "method": "prompt", "id": "1", "params": {"user_input": "你好"}}
```

`user_input` 可以是字符串或 `ContentPart` 数组。

**成功响应**

```json
{"jsonrpc": "2.0", "id": "1", "result": {"status": "finished"}}
```

| status | 说明 |
|--------|------|
| `finished` | 轮次正常完成 |
| `cancelled` | 轮次被 `cancel` 取消 |
| `max_steps_reached` | 达到最大步数限制，响应中额外包含 `steps` 字段 |

**错误响应**

```json
{"jsonrpc": "2.0", "id": "1", "error": {"code": -32001, "message": "LLM is not set"}}
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

```json
{"jsonrpc": "2.0", "method": "cancel", "id": "2"}
```

**成功响应**

```json
{"jsonrpc": "2.0", "id": "2", "result": {}}
```

**错误响应**

如果当前没有轮次在进行：

```json
{"jsonrpc": "2.0", "id": "2", "error": {"code": -32000, "message": "No agent turn is in progress"}}
```

### `event`

- **方向**：Agent → Client
- **类型**：Notification（无需响应）

Agent 在轮次进行过程中发出的事件。没有 `id` 字段，Client 无需响应。

```json
{"jsonrpc": "2.0", "method": "event", "params": {"type": "ContentPart", "payload": {"type": "text", "text": "Hello"}}}
```

### `request`

- **方向**：Agent → Client
- **类型**：Request（需要响应）

Agent 向 Client 发出的请求，目前仅用于审批请求。Client 必须响应后 Agent 才能继续执行。

```json
{"jsonrpc": "2.0", "method": "request", "id": "req-1", "params": {"type": "ApprovalRequest", "payload": {"id": "req-1", "tool_call_id": "tc-1", "sender": "Shell", "action": "run shell command", "description": "Run command `ls`", "display": []}}}
```

**响应**

Client 需要返回审批结果：

```json
{"jsonrpc": "2.0", "id": "req-1", "result": {"request_id": "req-1", "response": "approve"}}
```

`response` 可选值：

| response | 说明 |
|----------|------|
| `approve` | 批准本次操作 |
| `approve_for_session` | 批准本会话中的同类操作 |
| `reject` | 拒绝操作 |

## Wire 消息类型

Wire 消息通过 `event` 和 `request` 方法传递，格式为 `{"type": "...", "payload": {...}}`。以下使用 TypeScript 风格的类型定义描述所有消息类型。

```typescript
// 所有 Wire 消息的联合类型
type WireMessage = Event | Request

// 事件：通过 event 方法发送，无需响应
type Event =
  | TurnBegin | StepBegin | StepInterrupted
  | CompactionBegin | CompactionEnd | StatusUpdate
  | ContentPart | ToolCall | ToolCallPart | ToolResult
  | SubagentEvent | ApprovalRequestResolved

// 请求：通过 request 方法发送，需要响应
type Request = ApprovalRequest
```

### `TurnBegin`

轮次开始。

```typescript
interface TurnBegin {
  /** 用户输入，可以是纯文本或内容片段数组 */
  user_input: string | ContentPart[]
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
```

### `ContentPart`

消息内容片段。序列化时 `type` 为 `"ContentPart"`，具体类型由 `payload.type` 区分。

```typescript
type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart

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
  return_value: {
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

### `ApprovalRequestResolved`

审批请求已解决。

```typescript
interface ApprovalRequestResolved {
  /** 已解决的审批请求 ID */
  request_id: string
  /** 审批结果 */
  response: "approve" | "approve_for_session" | "reject"
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

### `DisplayBlock`

`ToolResult` 和 `ApprovalRequest` 的 `display` 字段使用的显示块类型。

```typescript
type DisplayBlock =
  | BriefDisplayBlock
  | DiffDisplayBlock
  | TodoDisplayBlock
  | UnknownDisplayBlock

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
  items: {
    /** 待办事项标题 */
    title: string
    /** 状态 */
    status: "pending" | "in_progress" | "done"
  }[]
}

/** 无法识别的显示块类型的 fallback */
interface UnknownDisplayBlock {
  /** 任意类型标识 */
  type: string
  /** 原始数据 */
  data: object
}
```

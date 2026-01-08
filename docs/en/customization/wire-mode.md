# Wire Mode

Wire mode is Kimi CLI's low-level communication protocol for structured bidirectional communication with external programs.

## What is Wire

Wire is the message-passing layer used internally by Kimi CLI. When you interact via terminal, the Shell UI receives AI output through Wire and displays it; when you integrate with IDEs via ACP, the ACP server also communicates with the Agent core through Wire.

Wire mode (`--wire`) exposes this communication protocol, allowing external programs to interact directly with Kimi CLI. This is suitable for building custom UIs or embedding Kimi CLI into other applications.

```sh
kimi --wire
```

## Use cases

Wire mode is mainly used for:

- **Custom UI**: Build web, desktop, or mobile frontends for Kimi CLI
- **Application integration**: Embed Kimi CLI into other applications
- **Automated testing**: Programmatic testing of agent behavior

::: tip
If you only need simple non-interactive input/output, [print mode](./print-mode.md) is simpler. Wire mode is for scenarios requiring full control and bidirectional communication.
:::

## Wire protocol

Wire uses a JSON-RPC 2.0 based protocol for bidirectional communication via stdin/stdout.

**Message format**

Each message is a single line of JSON conforming to JSON-RPC 2.0 specification:

```json
{"jsonrpc": "2.0", "method": "...", "params": {...}}
```

### `prompt`

- **Direction**: Client → Agent
- **Type**: Request (requires response)

Send user input and run an agent turn. After calling, the agent starts processing and returns a response only when the turn completes.

```json
{"jsonrpc": "2.0", "method": "prompt", "id": "1", "params": {"user_input": "Hello"}}
```

`user_input` can be a string or an array of `ContentPart`.

**Success response**

```json
{"jsonrpc": "2.0", "id": "1", "result": {"status": "finished"}}
```

| status | Description |
|--------|-------------|
| `finished` | Turn completed normally |
| `cancelled` | Turn cancelled by `cancel` |
| `max_steps_reached` | Max step limit reached, response includes additional `steps` field |

**Error response**

```json
{"jsonrpc": "2.0", "id": "1", "error": {"code": -32001, "message": "LLM is not set"}}
```

| code | Description |
|------|-------------|
| `-32000` | A turn is already in progress |
| `-32001` | LLM not configured |
| `-32002` | Specified LLM not supported |
| `-32003` | LLM service error |

### `cancel`

- **Direction**: Client → Agent
- **Type**: Request (requires response)

Cancel the currently running agent turn. After calling, the in-progress `prompt` request will return `{"status": "cancelled"}`.

```json
{"jsonrpc": "2.0", "method": "cancel", "id": "2"}
```

**Success response**

```json
{"jsonrpc": "2.0", "id": "2", "result": {}}
```

**Error response**

If no turn is in progress:

```json
{"jsonrpc": "2.0", "id": "2", "error": {"code": -32000, "message": "No agent turn is in progress"}}
```

### `event`

- **Direction**: Agent → Client
- **Type**: Notification (no response needed)

Events emitted by the agent during a turn. No `id` field, client doesn't need to respond.

```json
{"jsonrpc": "2.0", "method": "event", "params": {"type": "ContentPart", "payload": {"type": "text", "text": "Hello"}}}
```

### `request`

- **Direction**: Agent → Client
- **Type**: Request (requires response)

Request from agent to client, currently only used for approval requests. Client must respond before agent can continue.

```json
{"jsonrpc": "2.0", "method": "request", "id": "req-1", "params": {"type": "ApprovalRequest", "payload": {"id": "req-1", "tool_call_id": "tc-1", "sender": "Shell", "action": "run shell command", "description": "Run command `ls`", "display": []}}}
```

**Response**

Client needs to return approval result:

```json
{"jsonrpc": "2.0", "id": "req-1", "result": {"request_id": "req-1", "response": "approve"}}
```

`response` options:

| response | Description |
|----------|-------------|
| `approve` | Approve this operation |
| `approve_for_session` | Approve similar operations for this session |
| `reject` | Reject operation |

## Wire message types

Wire messages are transmitted via `event` and `request` methods, in format `{"type": "...", "payload": {...}}`. The following describes all message types using TypeScript-style type definitions.

```typescript
// Union type of all Wire messages
type WireMessage = Event | Request

// Events: sent via event method, no response needed
type Event =
  | TurnBegin | StepBegin | StepInterrupted
  | CompactionBegin | CompactionEnd | StatusUpdate
  | ContentPart | ToolCall | ToolCallPart | ToolResult
  | SubagentEvent | ApprovalRequestResolved

// Requests: sent via request method, require response
type Request = ApprovalRequest
```

### `TurnBegin`

Turn started.

```typescript
interface TurnBegin {
  /** User input, can be plain text or array of content parts */
  user_input: string | ContentPart[]
}
```

### `StepBegin`

Step started.

```typescript
interface StepBegin {
  /** Step number, starting from 1 */
  n: number
}
```

### `StepInterrupted`

Step interrupted, no additional fields.

### `CompactionBegin`

Context compaction started, no additional fields.

### `CompactionEnd`

Context compaction ended, no additional fields.

### `StatusUpdate`

Status update.

```typescript
interface StatusUpdate {
  /** Context usage ratio, float between 0-1, may be absent in JSON */
  context_usage?: number | null
  /** Token usage stats for current step, may be absent in JSON */
  token_usage?: TokenUsage | null
  /** Message ID for current step, may be absent in JSON */
  message_id?: string | null
}

interface TokenUsage {
  /** Input tokens excluding `input_cache_read` and `input_cache_creation`. */
  input_other: number
  /** Total output tokens. */
  output: number
  /** Cached input tokens */
  input_cache_read: number
  /** Input tokens used for cache creation. For now, only Anthropic API supports this. */
  input_cache_creation: number
}
```

### `ContentPart`

Message content part. Serialized with `type` as `"ContentPart"`, specific type distinguished by `payload.type`.

```typescript
type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart | VideoURLPart

interface TextPart {
  type: "text"
  /** Text content */
  text: string
}

interface ThinkPart {
  type: "think"
  /** Thinking content */
  think: string
  /** Encrypted thinking content or signature, may be absent in JSON */
  encrypted?: string | null
}

interface ImageURLPart {
  type: "image_url"
  image_url: {
    /** Image URL, can be data URI (e.g., data:image/png;base64,...) */
    url: string
    /** Image ID for distinguishing different images, may be absent in JSON */
    id?: string | null
  }
}

interface AudioURLPart {
  type: "audio_url"
  audio_url: {
    /** Audio URL, can be data URI (e.g., data:audio/aac;base64,...) */
    url: string
    /** Audio ID for distinguishing different audio, may be absent in JSON */
    id?: string | null
  }
}

interface VideoURLPart {
  type: "video_url"
  video_url: {
    /** Video URL, can be data URI (e.g., data:video/mp4;base64,...) */
    url: string
    /** Video ID for distinguishing different video, may be absent in JSON */
    id?: string | null
  }
}
```

### `ToolCall`

Tool call.

```typescript
interface ToolCall {
  /** Fixed as "function" */
  type: "function"
  /** Tool call ID */
  id: string
  function: {
    /** Tool name */
    name: string
    /** JSON-format argument string, may be absent in JSON */
    arguments?: string | null
  }
  /** Extra info, may be absent in JSON */
  extras?: object | null
}
```

### `ToolCallPart`

Tool call argument fragment (streaming).

```typescript
interface ToolCallPart {
  /** Argument fragment for streaming tool call arguments, may be absent in JSON */
  arguments_part?: string | null
}
```

### `ToolResult`

Tool execution result.

```typescript
interface ToolResult {
  /** Corresponding tool call ID */
  tool_call_id: string
  return_value: ToolReturnValue
}

interface ToolReturnValue {
  /** Whether this is an error */
  is_error: boolean
  /** Output content returned to model */
  output: string | ContentPart[]
  /** Explanatory message for model */
  message: string
  /** Display blocks shown to user */
  display: DisplayBlock[]
  /** Extra debug info, may be absent in JSON */
  extras?: object | null
}
```

### `SubagentEvent`

Subagent event.

```typescript
interface SubagentEvent {
  /** Associated Task tool call ID */
  task_tool_call_id: string
  /** Event from subagent, nested Wire message format */
  event: { type: string; payload: object }
}
```

### `ApprovalRequestResolved`

Approval request resolved.

```typescript
interface ApprovalRequestResolved {
  /** Resolved approval request ID */
  request_id: string
  /** Approval result */
  response: "approve" | "approve_for_session" | "reject"
}
```

### `ApprovalRequest`

Approval request, sent via `request` method, client must respond before agent can continue.

```typescript
interface ApprovalRequest {
  /** Request ID, used when responding */
  id: string
  /** Associated tool call ID */
  tool_call_id: string
  /** Sender (tool name) */
  sender: string
  /** Action description */
  action: string
  /** Detailed description */
  description: string
  /** Display blocks shown to user, may be absent in JSON, defaults to [] */
  display?: DisplayBlock[]
}
```

### `DisplayBlock`

Display block types used in `display` field of `ToolResult` and `ApprovalRequest`.

```typescript
type DisplayBlock =
  UnknownDisplayBlock
  | BriefDisplayBlock
  | DiffDisplayBlock
  | TodoDisplayBlock

/** Fallback for unrecognized display block types */
interface UnknownDisplayBlock {
  /** Any type identifier */
  type: string
  /** Raw data */
  data: object
}

interface BriefDisplayBlock {
  type: "brief"
  /** Brief text content */
  text: string
}

interface DiffDisplayBlock {
  type: "diff"
  /** File path */
  path: string
  /** Original content */
  old_text: string
  /** New content */
  new_text: string
}

interface TodoDisplayBlock {
  type: "todo"
  /** Todo list items */
  items: TodoDisplayItem[]
}

interface TodoDisplayItem {
  /** Todo item title */
  title: string
  /** Status */
  status: "pending" | "in_progress" | "done"
}
```

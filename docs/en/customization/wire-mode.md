# Wire mode

Wire mode is Kimi Code CLI's low-level communication protocol for structured bidirectional communication with external programs.

## What is Wire

Wire is the message-passing layer used internally by Kimi Code CLI. When you interact via terminal, the Shell UI receives AI output through Wire and displays it; when you integrate with IDEs via ACP, the ACP server also communicates with the agent core through Wire.

Wire mode (`--wire`) exposes this communication protocol, allowing external programs to interact directly with Kimi Code CLI. This is suitable for building custom UIs or embedding Kimi Code CLI into other applications.

```sh
kimi --wire
```

## Use cases

Wire mode is mainly used for:

- **Custom UI**: Build web, desktop, or mobile frontends for Kimi Code CLI
- **Application integration**: Embed Kimi Code CLI into other applications
- **Automated testing**: Programmatic testing of agent behavior

::: tip
If you only need simple non-interactive input/output, [print mode](./print-mode.md) is simpler. Wire mode is for scenarios requiring full control and bidirectional communication.
:::

## Wire protocol

Wire uses a JSON-RPC 2.0 based protocol for bidirectional communication via stdin/stdout. The current protocol version is `1.2`. Each message is a single line of JSON conforming to the JSON-RPC 2.0 specification.

### Protocol type definitions

```typescript
/** JSON-RPC 2.0 request message base structure */
interface JSONRPCRequest<Method extends string, Params> {
  jsonrpc: "2.0"
  method: Method
  id: string
  params: Params
}

/** JSON-RPC 2.0 notification message (no id, no response needed) */
interface JSONRPCNotification<Method extends string, Params> {
  jsonrpc: "2.0"
  method: Method
  params: Params
}

/** JSON-RPC 2.0 success response */
interface JSONRPCSuccessResponse<Result> {
  jsonrpc: "2.0"
  id: string
  result: Result
}

/** JSON-RPC 2.0 error response */
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

::: info Added
Added in Wire 1.1. Legacy clients can skip this request and send `prompt` directly.
:::

- **Direction**: client → agent
- **Type**: Request (requires response)

Optional handshake request for negotiating protocol version, submitting external tool definitions, and retrieving the slash command list.

```typescript
/** initialize request parameters */
interface InitializeParams {
  /** Protocol version */
  protocol_version: string
  /** Client info, optional */
  client?: ClientInfo
  /** External tool definitions, optional */
  external_tools?: ExternalTool[]
}

interface ClientInfo {
  name: string
  version?: string
}

interface ExternalTool {
  /** Tool name, must not conflict with built-in tools */
  name: string
  /** Tool description */
  description: string
  /** Parameter definition in JSON Schema format */
  parameters: JSONSchema
}

/** initialize response result */
interface InitializeResult {
  /** Protocol version */
  protocol_version: string
  /** Server info */
  server: ServerInfo
  /** Available slash commands */
  slash_commands: SlashCommandInfo[]
  /** External tool registration result, only returned when request includes external_tools */
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
  /** Successfully registered tool names */
  accepted: string[]
  /** Failed tool registrations with reasons */
  rejected: Array<{ name: string; reason: string }>
}
```

**Request example**

```json
{"jsonrpc": "2.0", "method": "initialize", "id": "550e8400-e29b-41d4-a716-446655440000", "params": {"protocol_version": "1.1", "client": {"name": "my-ui", "version": "1.0.0"}, "external_tools": [{"name": "open_in_ide", "description": "Open file in IDE", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}]}}
```

**Success response example**

```json
{"jsonrpc": "2.0", "id": "550e8400-e29b-41d4-a716-446655440000", "result": {"protocol_version": "1.1", "server": {"name": "Kimi Code CLI", "version": "0.69.0"}, "slash_commands": [{"name": "init", "description": "Analyze the codebase ...", "aliases": []}], "external_tools": {"accepted": ["open_in_ide"], "rejected": []}}}
```

If the server does not support the `initialize` method, the client will receive a `-32601 method not found` error and should automatically fall back to no-handshake mode.

### `prompt`

- **Direction**: Client → Agent
- **Type**: Request (requires response)

Send user input and run an agent turn. After calling, the agent starts processing and sends `event` notifications and `request` messages during execution, returning a response only when the turn completes.

```typescript
/** prompt request parameters */
interface PromptParams {
  /** User input, can be plain text or array of content parts */
  user_input: string | ContentPart[]
}

/** prompt response result */
interface PromptResult {
  /** Turn end status */
  status: "finished" | "cancelled" | "max_steps_reached"
  /** Number of steps executed when status is max_steps_reached */
  steps?: number
}
```

**Request example**

```json
{"jsonrpc": "2.0", "method": "prompt", "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "params": {"user_input": "Hello"}}
```

**Success response example**

```json
{"jsonrpc": "2.0", "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "result": {"status": "finished"}}
```

**Error response example**

```json
{"jsonrpc": "2.0", "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "error": {"code": -32001, "message": "LLM is not set"}}
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

```typescript
/** cancel request has no parameters, params can be empty object or omitted */
type CancelParams = Record<string, never>

/** cancel response result is empty object */
type CancelResult = Record<string, never>
```

**Request example**

```json
{"jsonrpc": "2.0", "method": "cancel", "id": "6ba7b811-9dad-11d1-80b4-00c04fd430c8"}
```

**Success response example**

```json
{"jsonrpc": "2.0", "id": "6ba7b811-9dad-11d1-80b4-00c04fd430c8", "result": {}}
```

**Error response example**

If no turn is in progress:

```json
{"jsonrpc": "2.0", "id": "6ba7b811-9dad-11d1-80b4-00c04fd430c8", "error": {"code": -32000, "message": "No agent turn is in progress"}}
```

### `event`

- **Direction**: agent → client
- **Type**: Notification (no response needed)

Events emitted by the agent during a turn. No `id` field, client doesn't need to respond.

```typescript
/** event notification parameters, contains serialized Wire message */
interface EventParams {
  type: string
  payload: object
}
```

**Example**

```json
{"jsonrpc": "2.0", "method": "event", "params": {"type": "ContentPart", "payload": {"type": "text", "text": "Hello"}}}
```

### `request`

- **Direction**: agent → client
- **Type**: Request (requires response)

Requests from the agent to the client, used for approval confirmation or external tool calls. The client must respond before the agent can continue execution.

```typescript
/** request parameters, contains serialized Wire message */
interface RequestParams {
  type: "ApprovalRequest" | "ToolCallRequest"
  payload: ApprovalRequest | ToolCallRequest
}
```

**Approval request example**

```json
{"jsonrpc": "2.0", "method": "request", "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "params": {"type": "ApprovalRequest", "payload": {"id": "approval-1", "tool_call_id": "tc-1", "sender": "Shell", "action": "run shell command", "description": "Run command `ls`", "display": []}}}
```

**Approval response example**

```json
{"jsonrpc": "2.0", "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "result": {"request_id": "approval-1", "response": "approve"}}
```

**External tool call request example**

```json
{"jsonrpc": "2.0", "method": "request", "id": "a3bb189e-8bf9-3888-9912-ace4e6543002", "params": {"type": "ToolCallRequest", "payload": {"id": "tc-1", "name": "open_in_ide", "arguments": "{\"path\":\"README.md\"}"}}}
```

**External tool call response example**

```json
{"jsonrpc": "2.0", "id": "a3bb189e-8bf9-3888-9912-ace4e6543002", "result": {"tool_call_id": "tc-1", "return_value": {"is_error": false, "output": "Opened", "message": "Opened README.md in IDE", "display": []}}}
```

### Standard error codes

All requests may return JSON-RPC 2.0 standard errors:

| code | Description |
|------|-------------|
| `-32700` | Invalid JSON format |
| `-32600` | Invalid request (e.g., missing required fields) |
| `-32601` | Method not found |
| `-32602` | Invalid method parameters |
| `-32603` | Internal error |

## Wire message types

Wire messages are transmitted via `event` and `request` methods, in format `{"type": "...", "payload": {...}}`. The following describes all message types using TypeScript-style type definitions.

```typescript
/** Union type of all Wire messages */
type WireMessage = Event | Request

/** Events: sent via event method, no response needed */
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

/** Requests: sent via request method, require response */
type Request = ApprovalRequest | ToolCallRequest
```

### `TurnBegin`

Turn started.

```typescript
interface TurnBegin {
  /** User input, can be plain text or array of content parts */
  user_input: string | ContentPart[]
}
```

### `TurnEnd`

::: info Added
Added in Wire 1.2.
:::

Turn ended. This event is sent after all other events in the turn. If the turn is interrupted, this event may be omitted.

```typescript
interface TurnEnd {
  // No additional fields
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
  /** Input tokens excluding input_cache_read and input_cache_creation */
  input_other: number
  /** Total output tokens */
  output: number
  /** Cached input tokens */
  input_cache_read: number
  /** Input tokens used for cache creation, currently only Anthropic API supports this field */
  input_cache_creation: number
}
```

### `ContentPart`

Message content part. Serialized with `type` as `"ContentPart"`, specific type distinguished by `payload.type`.

```typescript
type ContentPart =
  | TextPart
  | ThinkPart
  | ImageURLPart
  | AudioURLPart
  | VideoURLPart

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

### `ApprovalResponse`

::: info Changed
Renamed in Wire 1.1. Formerly `ApprovalRequestResolved`. The old name is still accepted for backwards compatibility.
:::

Approval response event, indicates an approval request has been completed.

```typescript
interface ApprovalResponse {
  /** Approval request ID */
  request_id: string
  /** Approval result */
  response: "approve" | "approve_for_session" | "reject"
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

**Response format**

Client needs to return `ApprovalResponse` as the response result:

```typescript
interface ApprovalResponse {
  request_id: string
  response: "approve" | "approve_for_session" | "reject"
}
```

| response | Description |
|----------|-------------|
| `approve` | Approve this operation |
| `approve_for_session` | Approve similar operations for this session |
| `reject` | Reject operation |

### `ToolCallRequest`

External tool call request, sent via `request` method. When the agent calls an external tool registered via `initialize`, this request is sent. The client must execute the tool and return a `ToolResult`.

```typescript
interface ToolCallRequest {
  /** Tool call ID */
  id: string
  /** Tool name */
  name: string
  /** JSON-format argument string, may be absent in JSON */
  arguments?: string | null
}
```

**Response format**

Client needs to return `ToolResult` as the response result:

```typescript
interface ToolResult {
  tool_call_id: string
  return_value: ToolReturnValue
}
```

### `DisplayBlock`

Display block types used in the `display` field of `ToolResult` and `ApprovalRequest`.

```typescript
type DisplayBlock =
  | UnknownDisplayBlock
  | BriefDisplayBlock
  | DiffDisplayBlock
  | TodoDisplayBlock
  | ShellDisplayBlock

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

interface ShellDisplayBlock {
  type: "shell"
  /** Language identifier for syntax highlighting (e.g., "sh", "powershell") */
  language: string
  /** Shell command content */
  command: string
}
```

## Kimi Agent (Rust) Wire server

::: warning Note
Kimi Agent is currently experimental. APIs and behavior may change in future releases.
:::

Kimi Agent (Rust) is the Rust implementation of the Kimi Code CLI kernel, designed specifically for Wire mode. If you only need the Wire protocol service, Kimi Agent (Rust) offers a more lightweight alternative. The Rust implementation lives in [`MoonshotAI/kimi-agent-rs`](https://github.com/MoonshotAI/kimi-agent-rs).

### Features

- **Full Wire protocol compatibility**: Uses the same Wire protocol as Python's `kimi --wire`, existing clients need no modifications
- **Smaller footprint**: Single statically-linked binary, no Python runtime required
- **Faster startup**: Native compilation provides faster startup times
- **Same configuration**: Uses the same config file (`~/.kimi/config.toml`) and session directories

### Limitations

- **Wire mode only**: No Shell/Print/ACP UI
- **Kimi provider only**: Does not support OpenAI, Anthropic, or other providers
- **No Kimi account login**: No `login`/`logout` subcommands or `/login`, `/logout` slash commands; requires manual API key configuration
- **No `--prompt`/`--command`**: Wire server does not accept initial prompts
- **Local execution only**: No SSH Kaos support
- **Different MCP OAuth storage**: Kimi Agent stores credentials in `~/.kimi/credentials/mcp_auth.json`, while Python version uses `~/.fastmcp/oauth-mcp-client-cache/`; they are incompatible

### Installation

Download pre-built binaries from [GitHub Releases](https://github.com/MoonshotAI/kimi-agent-rs/releases):

```sh
# macOS (Apple Silicon)
curl -L https://github.com/MoonshotAI/kimi-agent-rs/releases/latest/download/kimi-agent-aarch64-apple-darwin.tar.gz | tar xz
sudo mv kimi-agent /usr/local/bin/

# Linux (x86_64)
curl -L https://github.com/MoonshotAI/kimi-agent-rs/releases/latest/download/kimi-agent-x86_64-unknown-linux-gnu.tar.gz | tar xz
sudo mv kimi-agent /usr/local/bin/
```

### Usage

Kimi Agent runs in Wire mode by default:

```sh
kimi-agent
```

Common options are the same as the `kimi` command:

```sh
# Specify work directory
kimi-agent --work-dir /path/to/project

# Continue previous session
kimi-agent --continue

# Use specific session
kimi-agent --session <session-id>

# Use specific model
kimi-agent --model k2

# YOLO mode (skip approvals)
kimi-agent --yolo
```

Subcommands:

```sh
# Show version and environment info
kimi-agent info

# Manage MCP servers
kimi-agent mcp list
kimi-agent mcp add <name> <command> [args...]
kimi-agent mcp remove <name>
```

### Version synchronization

Kimi Agent is released independently from Kimi Code CLI. See `MoonshotAI/kimi-agent-rs` release notes for compatibility and sync status.

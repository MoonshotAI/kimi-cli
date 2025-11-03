# Wire over STDIO

Learn how `WireServer` (src/kimi_cli/ui/wire/__init__.py) exposes the Soul runtime over stdio.
Use this reference when building clients or SDKs.

## Transport
- The server acquires stdio streams via `acp.stdio_streams()` and stays alive until stdin closes.
- Messages use newline-delimited JSON. Each object must include `"jsonrpc": "2.0"`.
- Outbound JSON is UTF-8 encoded with compact separators `(",", ":")`.

## Lifecycle
1. A client launches `kimi` (or another entry point) with the wire UI enabled.
2. `WireServer.run()` spawns a reader loop on stdin and a writer loop draining an internal queue.
3. Incoming payloads are validated by `JSONRPC_MESSAGE_ADAPTER`; invalid objects only log warnings.
4. The Soul uses `Wire` (src/kimi_cli/wire/__init__.py); the UI forwards every message as JSON-RPC.
5. EOF on stdin or a fatal error cancels the Soul, rejects approvals, and closes stdout.

## Client → Server calls

### `run`
- Request:
  ```json
  {"jsonrpc": "2.0", "id": "<request-id>", "method": "run", "params": {"input": "<prompt>"}}
  ```
  `params.prompt` is accepted as an alias for `params.input`.
- Success results:
  - `{"status": "finished"}` when the run completes.
  - `{"status": "cancelled"}` when either side interrupts.
  - `{"status": "max_steps_reached", "steps": <int>}` when the step limit triggers.
- Error codes:
  - `-32000`: A run is already in progress.
  - `-32602`: The `input` or `prompt` parameter is missing or not a string.
  - `-32001`: LLM is not configured.
  - `-32002`: The chat provider reported an error.
  - `-32003`: The requested LLM is unsupported.
  - `-32099`: An unhandled exception occurred during the run.

### `interrupt`
- Request:
  ```json
  {"jsonrpc": "2.0", "id": "<request-id>", "method": "interrupt", "params": {}}
  ```
  The `id` field is optional; omitting it turns the request into a notification.
- Success results:
  - `{"status": "ok"}` when a running Soul acknowledges the interrupt.
  - `{"status": "idle"}` when no run is active.
- Interrupt requests never raise protocol errors.

## Server → Client traffic

### Event notifications
Events are JSON-RPC notifications with method `event` and no `id`.
Payloads come from `serialize_event` (src/kimi_cli/wire/message.py):
- `step_begin`: payload `{"n": <int>}` with the 1-based step counter.
- `step_interrupted`: no payload; the Soul paused mid-step.
- `compaction_begin`: no payload; a compaction pass started.
- `compaction_end`: no payload; always follows `compaction_begin`.
- `status_update`: payload `{"context_usage": <int>}` from `StatusSnapshot`.
- `content_part`: JSON object produced by `ContentPart.model_dump(mode="json", exclude_none=True)`.
- `tool_call`: JSON object produced by `ToolCall.model_dump(mode="json", exclude_none=True)`.
- `tool_call_part`: JSON object from `ToolCallPart.model_dump(mode="json", exclude_none=True)`.
- `tool_result`: object with `tool_call_id`, `ok`, and `result` (`output`, `message`, `brief`).
  When `ok` is true the `output` may be text, a JSON object, or an array of JSON objects for
  multi-part content.

Event order mirrors Soul execution because the server uses an `asyncio.Queue` for FIFO delivery.

### Approval requests
- Approval prompts use method `request`; their `id` equals the UUID in `ApprovalRequest.id`:
  ```json
  {
    "jsonrpc": "2.0",
    "id": "<approval-id>",
    "method": "request",
    "params": {
      "type": "approval",
      "payload": {
        "id": "<approval-id>",
        "tool_call_id": "<tool-call-id>",
        "sender": "<agent>",
        "action": "<action>",
        "description": "<human readable context>"
      }
    }
  }
  ```
- Clients reply with JSON-RPC success.
  `result.response` must be `approve`, `approve_for_session`, or `reject`:
  ```json
  {"jsonrpc": "2.0", "id": "<approval-id>", "result": {"response": "approve"}}
  ```
- Error responses or unknown values are interpreted as rejection.
- Unanswered approvals are auto-rejected during server shutdown.

## Error responses from the server
Errors follow JSON-RPC semantics.
The error object includes `code` and `message`.
Custom codes live in the `-320xx` range.
Clients should allow an optional `data` field even though the server omits it today.

## Shutdown semantics
- Shutdown cancels runs, stops the writer queue, rejects pending approvals, and closes stdout.
- EOF on stdout signals process exit; clients can treat it as terminal.

## Implementation notes for SDK authors
- Only one `run` call may execute at a time; queue additional runs client side.
- The payloads for `content_part`, `tool_call`, and `tool_call_part` already contain JSON objects.
- Approval handling is synchronous; always send a response even if the user cancels.
- Logging is verbose for non-stream messages; unknown methods are ignored for forward compatibility.

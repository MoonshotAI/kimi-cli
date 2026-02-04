# Wire Module Notes

## Scope

- `types.rs`: wire message structs/enums + `WireMessageEnvelope`.
- `serde.rs`: JSON (de)serialization helpers.
- `file.rs`: `WireFile` JSONL persistence, metadata header, `WireMessageRecord`.
- `protocol.rs`: wire protocol version constants.
- `jsonrpc.rs`: JSON-RPC models/utilities for wire server.
- `server.rs`: stdio JSON-RPC wire server.
- `channel.rs`: `Wire`, `WireSoulSide`, `WireUISide`, merge + recording logic.

## Compatibility Rules

- Envelope `type` strings must match Python class names.
- `ContentPart` wire messages always use `type="ContentPart"` at the envelope layer.
- `ApprovalRequestResolved` must map to `ApprovalResponse` for backward compatibility.
- `SubagentEvent.event` is serialized as an embedded `WireMessageEnvelope`.

## Merge Behavior

- `WireSoulSide` merges adjacent `ContentPart`, `ToolCall`, and `ToolCallPart` via `merge_in_place`.
- `flush()` emits the current merge buffer before non-mergeable events.

## Subscription Notes

- `Wire` pre-subscribes a default UI queue so early events are buffered before the UI loop starts.
- `Wire::join()` must be awaited after `Wire::shutdown()` to flush recorder writes.

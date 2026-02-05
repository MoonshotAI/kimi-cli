# Kosong Core Notes

## Scope

- `message.rs`: canonical message/content types; serialization must match Python exactly.
- `chat_provider/`: provider traits + concrete providers (Kimi, Echo, ScriptedEcho).
- `tooling/`: tool schemas, tool results, display blocks, and toolset dispatch.
- `generate.rs` + `lib.rs`: streaming merge and tool-call orchestration.

## Compatibility Rules

- `Message.content` serialization: single `TextPart` -> JSON string; otherwise array of parts.
- `ContentPart` and `ToolCall*` field names/types must remain wire-compatible.
- `Wire` uses `ContentPart::merge_in_place`; keep merge behavior aligned with Python.

## Streaming Behavior

- `StreamedMessage::next_part` returns `Result<Option<StreamedMessagePart>, ChatProviderError>`.
- `StreamedMessagePart::merge_in_place` must mirror Python merge semantics.

## Tooling

- `ToolReturnValue` JSON and display blocks are used by wire + UI integrations.
- `DisplayBlock` keeps unknown blocks as `UnknownDisplayBlock` for forward compatibility.

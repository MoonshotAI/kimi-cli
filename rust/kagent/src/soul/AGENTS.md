# Soul Module Notes

## Scope (current)

- `context.rs`: JSONL-backed conversation history with checkpoints and rotations.
- `message.rs`: helper conversions for system/tool messages and capability checks.
- `agent.rs`: runtime bootstrapping, builtin args, agent + labor market.
- `approval.rs`: approval request queue + auto-approve/Yolo handling.
- `compaction.rs`: compaction prompt construction and application.
- `denwarenji.rs`: D-Mail checkpoint handling.
- `toolset.rs`: tool loading/dispatch + MCP tool bridge; avoid auto `mcp-session-id` headers.
- `kimisoul.rs`: main agent loop, step orchestration, flow runner.

## Compatibility Rules

- Context file lines use:
  - messages as JSON (Message schema)
  - `{"role":"_usage","token_count":...}`
  - `{"role":"_checkpoint","id":...}`
- `checkpoint(add_user_message=true)` must append a user `<system>CHECKPOINT ...</system>` entry.
- `revert_to` and `clear` rotate files using `next_available_rotation`.

## Loop Behavior

- `KimiSoul::run` emits `TurnBegin` before each turn (including flow steps).
- Ralph loop uses `FlowRunner::ralph_loop` to replay prompts until STOP/limit.
- Each step spawns a dedicated approval piping task; it is canceled after the step finishes.
- `StepInterrupted` is emitted for any step error (compaction/checkpoint/step), except D-Mail back-to-future.
- Pending D-Mail triggers a context revert + checkpoint + D-Mail message append on the next loop iteration.
- Compaction retries use the same backoff rules as step retries.
- Flow runners warn on extra args and otherwise ignore them.

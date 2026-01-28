# tests_e2e Wire E2E Guide

## Goals and Scope
- Test only `kimi --wire` JSON-RPC + wire messages; no Shell UI/Print/ACP/Term/shortcuts.
- Do not test `--agent okabe`.
- Do not test: W-23, W-26, W-29, W-27 (env overrides).

## Execution Rules
- Tests run via `uv run kimi` by default; set `KIMI_E2E_WIRE_CMD` to override the base command
  (e.g. `./rust/target/debug/kimi` or `cargo run -p kimi-cli --`). `--wire` is appended if missing.
- Always isolate `HOME`, `USERPROFILE`, and `KIMI_SHARE_DIR`, and use a temporary `--work-dir` to
  avoid touching real `~/.kimi`.
- Use `inline_snapshot` for snapshot testing; snapshots can start empty and be updated later.
- Wire traffic is line-delimited JSON; `event`/`request`/responses may interleave.

## Test Matrix
**Startup and Protocol**
- W-01 Handshake: `initialize` returns `protocol_version=1.1`, `server`, and non-empty
  `slash_commands`.
- W-02 External tool registration and call: register `external_tools`, trigger a
  `ToolCallRequest`, return `ToolResult`, turn finishes.
- W-03 External tool conflict: registering a tool name that conflicts with a built-in is
  rejected with a reason.
- W-04 Prompt without handshake: send `prompt` without `initialize`, turn still completes.
- W-05 LLM not set: missing config yields `-32001` (LLM is not set).
- W-06 Max steps: set a tiny `--max-steps-per-turn`, response is `status=max_steps_reached`.

**Prompt and Event Stream**
- W-07 Basic turn: `TurnBegin`/`StepBegin`/`ContentPart(text)`/`StatusUpdate` flow.
- W-08 Multiline input: `TurnBegin.user_input` preserves newlines.
- W-09 Content parts input: `user_input` as `ContentPart[]` (text/image/audio/video) with
  capabilities enabled.
- W-10 Thinking toggle: `--thinking` emits `ContentPart(type=think)`, `--no-thinking` does not
  (real LLM).
- W-11 Concurrent prompt: second `prompt` returns `-32000` (turn already in progress).
- W-12 Cancel turn: `cancel` returns `{}`, original `prompt` becomes `status=cancelled`
  (may emit `StepInterrupted`, real LLM).

**Tools and Approvals**
- W-13 Shell approval: `Shell` triggers `ApprovalRequest`, `approve` yields `ToolResult`.
- W-14 Approval reject: `reject` ends turn; tool does not run.
- W-15 Session approval: `approve_for_session` removes subsequent blocking approvals.
- W-16 YOLO: `--yolo` skips blocking approvals.
- W-17 DisplayBlock coverage: `Shell`/`WriteFile`/`StrReplaceFile`/`SetTodoList` emit expected
  display types.
- W-18 Tool args streaming: `ToolCallPart.arguments_part` can be stitched into full args.

**Sessions and Context**
- W-19 Session files: `--session <id>` writes `context.jsonl` and `wire.jsonl`.
- W-20 Continue session: `--continue` appends to the same session files.
- W-21 Clear context: `/clear` ensures the next `prompt` does not rely on prior context.
- W-22 Manual compaction: `/compact` triggers `CompactionBegin/CompactionEnd`.
- W-24 Status stats: `StatusUpdate.context_usage/token_usage` types are valid and change over time.

**Config and Runtime Flags**
- W-25 `--config` inline: JSON/TOML string config works.
- W-28 CLI override: `--model` overrides `default_model`.
- W-30 Work dir: `prompt` asks "where is the current directory", verify `--work-dir` (real LLM).

**Extensions (Agents/Skills/MCP)**
- W-31 Built-in agent boundary: `default` calling `SendDMail` fails or is rejected.
- W-32 Custom agent: `--agent-file` excludes tool and calls are rejected.
- W-33 Subagents: prompt "parallel call two task tools, each runs shell sleep 0.5 and 1 second";
  verify Task/SubagentEvent streaming/ToolResult/multiple approvals (real LLM).
- W-34 Skill call: create a test skill, `/skill:test` injects `SKILL.md` (wire has no `/help`).
- W-35 Flow skill: `/flow:<name>` runs the flow until `END`.
- W-36 MCP: use a Python fastmcp test server, load via `--mcp-config-file`, verify tool works.

**Resilience and Errors**
- W-37 Invalid JSON: malformed JSON line returns `-32700`.
- W-38 Invalid request: missing fields returns `-32600`.
- W-39 Unknown method: returns `-32601`.
- W-40 Invalid params: bad structure returns `-32602`.
- W-41 Cancel without active turn: returns `-32000`.
- W-42 LLM errors: unsupported model `-32002` and service error `-32003`.

## Real LLM Placeholders
- W-10/W-12/W-30/W-33 require a real provider; everything else uses `_scripted_echo`.

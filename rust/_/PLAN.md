# Rust Rewrite Plan (kimi-cli / kosong / kaos)

Goal: rewrite the core Python implementation in Rust (workspace under `rust/`) with full
behavioral + data-format compatibility, retaining the three-crate split and Wire interface,
while omitting Print UI, Shell UI, and ACP UI support. All required tests are re-authored in Rust.

---

## Progress (rolling)

- Done: Rust workspace + crate skeletons; Kosong message/tooling + Echo/ScriptedEcho + Kimi provider; Kaos Local/current + KaosPath; Kimi Code CLI wire types + wire serde + wire queue + broadcast/queue utils; Config + share + exception types; LLM provider wiring (Kimi/Echo/ScriptedEcho); Metadata + Session handling; Agent spec loading/extension; Context storage + path utils; Skills + flow parsing + frontmatter utils; Soul core scaffold (errors + run_soul + wire context); Slash command utils; Approval flow core + tool-call context; Prompts (init/compact) + compaction implementation; Environment + DenwaRenji; Agent runtime loader; KimiToolset tool mapping + self-arc injection for CreateSubagent; KimiSoul core loop + flow runner; Diff utils + DisplayBlock support for diff/todo/shell; Tool descriptions embedded in Rust; Shell + File + DMail + Multiagent tools implemented; Web tools implemented (service calls + HTTP + extraction); WireOverStdio JSON-RPC server + protocol types (wire UI); KimiCLI app create/run + wire stdio runner; CLI entrypoint (wire-only) + info + MCP config management + `mcp test`; MCP config helpers module; MCP tool loading + JSON-RPC client (http/stdio) + MCP content conversion; FetchURL extraction test; Added message_stringify + read_frontmatter; aligned unified diff formatting; ported config/diff/frontmatter/message utils tests; ported broadcast queue, path rotation, list_directory, slash_command, ToolResultBuilder, environment, and file type detection tests; added queue qsize/get_nowait; adjusted Windows stat permissions for list_directory expectations; aligned schema generation normalization (inline subschemas, strip titles/format, type→anyOf, int normalization) + WriteFile enum default; ported tool description/schema tests (Task/CreateSubagent/DMail/Shell/Read/Write/Replace/Glob/Grep/Web/Todo/Think).
- Done: Added TestKaos guard + runtime fixture capabilities helper; made file/glob constants public; added ReadFile param validation; ported tool behavior tests for ReadFile, WriteFile, StrReplaceFile, Glob, Grep, ReadMediaFile (incl. capability descriptions), FetchURL (direct + service), and CreateSubagent; added wiremock dev dependency for HTTP mocks.
- Done: Switched LocalKaos glob to `glob` crate for Path.glob-compatible matching; adjusted FetchURL test fixtures (wiremock content types) and ReadFile expectations; tool behavior test suite now passes end-to-end.
- Done: Ported core tests for exceptions, wire message serde/record handling, soul message conversion/capability checks, and session behavior; aligned MaxStepsReached error message casing; added filetime dev dependency for mtime control.
- Done: Added ChatProvider `as_any` for downcasting, exposed Kimi `model_parameters`, normalized Kimi base_url trailing slash, and ported create_llm tests (env overrides + model parameter assertions).
- Done: Copied default/okabe agent specs into Rust crate; hardened agent spec version parsing (numeric versions); ported agent spec test suite with default + extend + validation cases.
- Done: Copied builtin skills into Rust crate; ported skill discovery/flow/roots tests with env override handling.
- Done: Ported flow parsing tests (mermaid + d2 + parse_choice) with deterministic snapshots.
- Done: Ported load_agents_md tests (AGENTS.md and agents.md lookup).
- Done: Ported load_agent/toolset tests (system prompt substitution, valid/invalid tool loading, invalid agent tools).
- Done: Ported default agent test with deterministic prompt substitution; adjusted Task tool init to avoid blocking mutex in async runtime.
- Done: Ported SimpleCompaction prepare tests as unit tests in `soul/compaction.rs`.
- Done: Ported KimiSoul flow skill slash command registration test.
- Done: Fixed ralph loop prompt handling to preserve ContentPart inputs; avoided blocking mutex in KimiSoul init; ported ralph loop tests (replay, stop choices, tool rejection, disabled loop).
- Done: Added wire-mode e2e tests for basic scripted echo and media inputs; added e2e helpers with optional trace and robust binary lookup.
- Done: Fixed ScriptedEcho thinking clone to avoid blocking tokio runtime; ensured KimiSoul status avoids blocking lock.
- Done: Resolved file tool path resolution relative to work dir; updated validation to use resolved paths.
- Done: Prevented early wire events from being dropped by pre-subscribing default UI queues.
- Done: Converted core persistence IO (config/metadata/session/mcp/agentspec/frontmatter) to async Tokio fs; removed sync fs usage in runtime code.
- Done: Split file/web/multiagent tools into per-tool modules with re-exports; rewrote Grep to run rg and auto-download the binary.
- Done: Replaced custom MCP client/tool loading with `rmcp` (modelcontextprotocol rust SDK), including OAuth flow + persistent credentials and stdio/HTTP transports.
- Done: Split CLI entrypoint so `main.rs` is thin and `info`/`mcp` subcommands live in `cli/` modules.
- Done: Aligned slash `/init` temp context handling and approval piping lifecycle with Python behavior.
- Done: Adjusted MCP CLI output and flow-runner arg handling to mirror Python UX.
- Done: Hardened WireOverStdio parity (response validation, error messages, shutdown handling) and external tool validation/conflict checks.
- Needs work (parity gaps found): re-verify tool behaviors and prompts against Python after refactors.
- Done: Added test-only tools (`plus`, `compare`, `panic`) and wired loader entries.
- Done: Added tool panic handling to return `Tool runtime error` instead of crashing step.
- Done: Added async logging initialization + basic config/provider/thinking log entries.
- Done: Expanded logging parity across core modules (`config`, `metadata`, `session`, `skill`,
  `soul/*`, `wire/*`, `ui/wire`, `tools/web`, `tools/file`, `kosong/generate`).
- Done: Expanded wire-mode e2e tests to cover skills/flows, external tools, approvals, built-in
  tools (incl. DMail/Think), parallel tool calls, Task/subagent events, session restore, agent
  file loading, MCP tool execution, and CLI/LLM error handling; fixed MCP wait deadlock by
  awaiting outside toolset lock and emit ToolResult wire events for async tool results.
- Done: Fixed `ToolReturnValue.extras` serialization to omit nulls; `cargo test` passes.
- Done: Aligned FlowRunner arg handling (warn-only), `/init` temp context lifecycle, per-step
  approval piping + StepInterrupted on step errors, BackToTheFuture handling for D-Mail, and
  compaction retry loop parity with Python.
- Done: Fixed ToolCallPart JSON null serialization, ToolResultBuilder line-splitting parity,
  Wire merge behavior for ToolCall + ToolCallPart, external tool schema validation, and
  LocalKaos glob dotfile semantics; normalized ReadFile newlines.
- Done: Added Kaos `read_lines_stream` + Shell stdout/stderr concurrent reads; ReadFile now streams
  lines with byte/line caps; Shell runtime errors map to ToolRuntimeError; success message parity.
- Done: Env var parsing now errors on invalid values and skips empty overrides; added tests.
- Done: Removed `KIMI_SHARE_DIR` override (use HOME like Python) and updated tests to set HOME;
  added share dir ensure helper; tightened metadata/session IO error handling and session ID
  deduping.
- Done: Dropped Rust `display_version` trimming and now emit raw `VERSION` in CLI/info/wire/MCP
  client metadata to match Python's version reporting.
- In progress: Full module rescan + parity audit against Python and docs (wire protocol, soul
  loop, tools, config/session/metadata, and kosongs/kaos core behavior).

## Immediate Parity Fixes (blocking)

These are required before further feature work. They address known behavioral or architectural
divergence from the Python implementation.

1. **Behavioral parity pass**
   - Re-check tool schemas/descriptions for exact match with Python.
   - Re-check KimiSoul loop prompts/tool result formatting after refactors.
   - Re-run Rust tests and add missing ones if needed.
2. **MCP and CLI structural fixes**
   - Swap custom MCP HTTP/stdio JSON-RPC client for `rmcp` client + transports. (done)
   - Preserve `mcp.json` schema + CLI flags; use `rmcp` OAuth storage (best practice). (done)
   - Move `mcp` and `info` command logic out of `main.rs` into `cli/` modules. (done)

## 0. Constraints & Compatibility Targets

- **Crates**: `rust/kagent`, `rust/kosong`, `rust/kaos` (workspace members).
- **Rust stack**: latest toolchain + edition, `tokio`, `serde`, `anyhow`, `thiserror`,
  `clap`, `reqwest`, plus best‑practice community crates where appropriate.
- **Binary**: build single executable for macOS/Linux/Windows (no Python runtime).
- **CLI flags**: match Python CLI except Print/Shell/ACP-related flags and features; keep
  Wire mode (`--wire`) and core config/session/agent flags.
- **Data compatibility**:
  - Config files (`~/.kimi/config.toml` and legacy JSON migration).
  - Metadata (`~/.kimi/kimi.json`), sessions (`~/.kimi/sessions/...`), context JSONL,
    wire JSONL (`wire.jsonl`).
  - Wire JSON-RPC protocol version `1.1` and message payload schema.
  - **Exact** structural match for `kosong.message.*` and `kimi_cli.wire.types.*`.
- **Providers**: implement only Kimi, Echo, ScriptedEcho, and keep abstraction to add more.
- **Kaos**: implement only LocalKaos; preserve abstraction and path semantics for future SSH.
- **Tests**: port unit/integration/e2e except:
  - UI (Shell/Print/ACP) tests
  - shell‑interaction‑only tests
  - non‑Kimi provider tests (OpenAI/Anthropic/Google/etc)

---

## 1. Workspace & Crate Layout

Create `rust/Cargo.toml` workspace with members:

- `rust/kagent` (bin + lib)
- `rust/kosong` (lib)
- `rust/kaos` (lib)

Target module layout mirroring Python (adjusted for Rust idioms):

- `rust/kosong/src/`:
  - `lib.rs` (re-export core APIs)
  - `message.rs` (ContentPart, Message, ToolCall, ToolCallPart)
  - `chat_provider/mod.rs` (traits, errors, TokenUsage, ThinkingEffort)
  - `chat_provider/kimi.rs` (Kimi API client + streaming)
  - `chat_provider/echo/{mod.rs, dsl.rs, scripted_echo.rs, echo.rs}`
  - `tooling/mod.rs` (Tool, ToolReturnValue, Toolset traits)
  - `tooling/{error.rs, simple.rs, empty.rs, mcp.rs}`
  - `utils/{typing.rs, aio.rs, jsonschema.rs}`
  - `_generate.rs` + `generate`/`step` in `lib.rs`

- `rust/kaos/src/`:
  - `lib.rs` (Kaos trait, current Kaos, global helpers)
  - `local.rs` (LocalKaos)
  - `path.rs` (KaosPath)
  - `_current.rs` (task‑local/global current Kaos)

- `rust/kagent/src/`:
  - `lib.rs` (core entrypoints)
  - `main.rs` (CLI)
  - `constant.rs`, `exception.rs`
  - `config.rs` (TOML/JSON load/save/migrate)
  - `metadata.rs`, `session.rs`, `share.rs`
  - `agentspec.rs`
  - `llm.rs`
  - `skill/` (skill discovery + flow parser)
  - `soul/` (agent runtime, context, compaction, approval, toolset, kimisoul)
  - `tools/` (shell, file, web, todo, multiagent, dmail, think, display, utils)
  - `wire/` (types, serde, Wire, WireOverStdio JSON-RPC)
  - `ui/wire/` (jsonrpc types + protocol version; only wire UI retained)
  - `utils/` (aio queue, broadcast, path helpers, diff, frontmatter, slashcmd, logging, env)

Add sub‑directory `AGENTS.md` for key module trees (at least):
`rust/kagent/src/soul/AGENTS.md`, `rust/kagent/src/wire/AGENTS.md`,
`rust/kosong/src/AGENTS.md`, `rust/kaos/src/AGENTS.md`.

---

## 2. Data Model & Serialization Fidelity

### 2.1 `kosong.message`

Implement Rust types with serde to match Python fields & behaviors:

- `ContentPart` variants (tagged by `type`):
  - `TextPart { type="text", text }`
  - `ThinkPart { type="think", think, encrypted? }`
  - `ImageURLPart { type="image_url", image_url: { url, id? } }`
  - `AudioURLPart { type="audio_url", audio_url: { url, id? } }`
  - `VideoURLPart { type="video_url", video_url: { url, id? } }`
- `ToolCall { type="function", id, function:{name, arguments?}, extras? }`
- `ToolCallPart { arguments_part? }`
- `Message`:
  - `role` in `["system","user","assistant","tool"]`
  - `content`: serde behavior:
    - **Serialize** single `TextPart` as a string; else as array of parts.
    - **Deserialize** string → `[TextPart]`; null → `[]`.
  - `tool_calls?`, `tool_call_id?`, `name?`, `partial?`.

### 2.2 `kosong.tooling`

- `Tool` JSON schema validation (Draft 2020-12).
- `DisplayBlock` dynamic typing with unknown fallback:
  - `UnknownDisplayBlock { type: <original>, data: {...} }`.
- `ToolReturnValue` with `is_error`, `output`, `message`, `display`, `extras?`.
  - `ToolOk`/`ToolError` constructors.
- Callable tool traits:
  - `CallableTool` (raw JSON args; validate via schema).
  - `CallableTool2<T>` (typed params; JSON → struct via serde).
- `ToolResult` and `Toolset` trait; async handle behavior must mirror Python.

### 2.3 `kimi_cli.wire.types`

- Wire message variants:
  - Events: `TurnBegin`, `StepBegin`, `StepInterrupted`, `CompactionBegin`,
    `CompactionEnd`, `StatusUpdate`, `ContentPart`, `ToolCall`, `ToolCallPart`,
    `ToolResult`, `ApprovalResponse`, `SubagentEvent`.
  - Requests: `ApprovalRequest`, `ToolCallRequest`.
- `WireMessageEnvelope { type, payload }`:
  - `type` string **must** equal Python class name.
  - Support legacy `ApprovalRequestResolved` → `ApprovalResponse`.
- `ApprovalRequest`/`ToolCallRequest` need internal async response channels but must
  serialize *only* public fields.

---

## 3. Core Runtime & Behavior Parity

### 3.1 Kosong generate/step

- Streaming merge behavior (`Mergeable`):
  - `TextPart` merges with `TextPart`.
  - `ThinkPart` merges if `encrypted` is empty.
  - `ToolCall` merges with `ToolCallPart` to build `function.arguments`.
- `generate` builds `Message` with merged parts, calls tool callbacks for completed tool calls.
- `step` dispatches tool calls through `Toolset` and returns `StepResult` with futures.

### 3.2 Kimi Code CLI runtime

- `Runtime::create` builds:
  - builtin args: `KIMI_NOW`, `KIMI_WORK_DIR`, `KIMI_WORK_DIR_LS`,
    `KIMI_AGENTS_MD`, `KIMI_SKILLS`
  - skill discovery (builtin + user + project dirs)
  - `Approval`, `DenwaRenji`, `LaborMarket`, `Environment`
- `load_agent`:
  - YAML spec with inheritance (`extend`), subagents, tools inclusion/exclusion
  - System prompt substitution with builtin args & spec args
  - Toolset initialization + dependency injection
  - MCP tool loading (see §5)
- `KimiSoul` loop:
  - slash commands + skill/flow commands
  - compaction (reserved context threshold)
  - approval request forwarding via Wire
  - tool execution, `ToolRejectedError` handling
  - D-Mail checkpoint rewind logic
  - Ralph Loop (flow‑based repeated turns)
- `Context` JSONL format:
  - Message lines, `_checkpoint` lines, `_usage` lines
  - rotate file on clear/revert (matching `next_available_rotation`)

---

## 4. Built-in Tools (Rust)

Implement each tool with same behavior, descriptions, and schemas:

- `Shell` (uses Kaos exec + approval + timeout + output truncation).
- `File` tools:
  - `ReadFile`, `ReadMediaFile`, `WriteFile`, `StrReplaceFile`, `Glob`, `Grep`.
  - File type detection (`MEDIA_SNIFF_BYTES`, mimetypes, magic bytes).
  - Diff display blocks and structured output.
  - Grep uses `rg` binary with identical options to Python.
- `Web` tools:
  - `SearchWeb` (Moonshot Search service, headers, error behavior).
  - `FetchURL` (Moonshot Fetch service, headers, output limits).
- `Todo` tool: `SetTodoList` with display blocks.
- `Multiagent` tools: `CreateSubagent`, `Task`.
  - Task spawns subagent `KimiSoul`, streams subagent events as `SubagentEvent`.
- `DMail`: `SendDMail` and DenwaRenji integration.
- `Think` tool (pass-through thought).

Utilities to port:

- `ToolResultBuilder`, output truncation (max chars/lines) + display blocks.
- `display` blocks: `DiffDisplayBlock`, `TodoDisplayBlock`, `ShellDisplayBlock`.
- Path helpers: `is_within_directory`, `list_directory`.

---

## 5. MCP Support Plan

Goal: match Python capabilities for MCP config and tool loading.

1. **Config**: parse global `~/.kimi/mcp.json` and CLI overrides:
   - Accept `mcpServers` with `url` (HTTP) or `command/args` (stdio).
2. **Client**:
   - **Use `modelcontextprotocol` rust SDK** for stdio + HTTP transports.
   - Implement wrapper layer to normalize SDK tool specs into `Tool` metadata.
   - Do not auto-inject `mcp-session-id` headers; rely on explicit config only.
   - Preserve server status (`pending`, `connecting`, `connected`, `failed`, `unauthorized`).
3. **KimiToolset**:
   - Register MCP tools as `CallableTool` proxies.
   - Do not attach `mcp-session-id` headers implicitly (some servers reject them).
   - Track server status (`pending`, `connecting`, `connected`, `failed`, `unauthorized`).

---

## 6. CLI & WireOverStdio

### CLI (`kimi-cli` bin)

- Implement `kimi` with clap:
  - Basic config: `--work-dir`, `--session`, `--continue`, `--config`,
    `--config-file`, `--model`, `--thinking`
  - Run control: `--yolo`, `--prompt`, `--wire`, loop controls
  - Customization: `--agent`, `--agent-file`, `--mcp-config-file`, `--mcp-config`,
    `--skills-dir`
  - Output: only Wire mode supported; non‑wire UI flags omitted or error.
  - Subcommands: `info`, `mcp` (add/list/remove/auth), possibly `term`/`acp` omitted.

### WireOverStdio

- JSON-RPC 2.0 line‑delimited (stdin/stdout).
- Implement `initialize`, `prompt`, `cancel`, `event`, `request` messages.
- Maintain pending request map for tool calls and approvals.
- Emit error codes per spec (`-32000..-32003`, JSON-RPC standard codes).
- Ensure message serialization matches `docs/zh/customization/wire-mode.md`.

---

## 7. Tests (Rust)

### Kosong

- `message` serialization/deserialization parity.
- `tooling` schema validation + error handling.
- `generate/step` merging behavior, tool call handling.
- Echo DSL parser (valid/invalid cases, usage parsing).
- Scripted echo queue consumption.

### Kaos

- LocalKaos path semantics, file IO, exec basics (non‑shell).
- KaosPath canonical/relative/expanduser behavior.

### Kimi Code CLI core

- Config load/save/migration (JSON→TOML).
- Agent spec parsing + inheritance.
- Session metadata + context JSONL read/write.
- Slash command parsing.
- Skill discovery + flow parsing (mermaid/d2).
- Wire message envelope + serde.
- KimiSoul step/loop behavior with Echo/ScriptedEcho providers.
- Tool schemas + descriptions match expectations.
- E2E scripted runs (similar to `tests/e2e`), excluding UI and shell‑interaction tests.

---

## 8. Implementation Phases (Execution Order)

1. **Toolchain & Workspace**
   - `rustup update` to latest stable; create Cargo workspace + crate skeletons.
   - Set base dependencies and shared features (`tokio`, `serde`, `reqwest`, `thiserror`, etc).

2. **Kosong Core**
   - Message types + merge behavior.
   - Tooling traits + schema validation + display blocks.
   - Generate/step pipeline.
   - Echo + ScriptedEcho providers + DSL parser.
   - Kimi provider with streaming + file upload support.

3. **Kaos Core**
   - Kaos trait + current Kaos global.
   - KaosPath + LocalKaos (fs + exec).

4. **Kimi Code CLI Core**
   - Config/metadata/session/share/agentspec/llm.
   - Skill discovery + flow parsers (mermaid, d2).
   - Soul runtime + context + compaction + approvals + toolset.
   - Wire types + Wire + WireOverStdio.

5. **Tools**
   - Split tool modules to mirror Python layout.
   - Port all core tools with schemas/descriptions and display blocks.
   - Ensure tool behavior matches Python (limits, errors, `rg` behavior for Grep).

6. **Tests**
   - Port eligible tests, ensure format/behavior compatibility.
   - Add regression tests for wire JSON, config migration, context JSONL.

7. **Validation**
   - `cargo test` for all crates.
   - Run scripted e2e tests (Echo/ScriptedEcho).
   - Manual spot checks for ~/.kimi metadata read-only compatibility.

---

## 9. Notes on Risky Areas

- JSON serialization parity for `Message.content` and Wire messages (custom serde needed).
- MCP client behavior and tool schema conversion.
- Flow parsing (Mermaid/D2) correctness vs Python implementation.
- Context compaction and step retry semantics (tenacity equivalent).
- Shell tool timeouts + output truncation behavior.

---

## 10. Module Audit (2025-02-14)

Scope review against required Python core modules, with Rust mapping + gap notes.

### 10.1 kimi-cli core (Python → Rust)

- `src/kimi_cli/agentspec.py` → `rust/kagent/src/agentspec.rs` (done).
- `src/kimi_cli/app.py` → `rust/kagent/src/app.rs` (done; **gap**: logging parity, see 10.4).
- `src/kimi_cli/cli/*` → `rust/kagent/src/cli/*` (wire-only; print/shell/acp flags omitted).
- `src/kimi_cli/config.py` → `rust/kagent/src/config.rs` (done).
- `src/kimi_cli/constant.py` → `rust/kagent/src/constant.rs` (done).
- `src/kimi_cli/exception.py` → `rust/kagent/src/exception.rs` (done).
- `src/kimi_cli/llm.py` → `rust/kagent/src/llm.rs` (done).
- `src/kimi_cli/metadata.py` → `rust/kagent/src/metadata.rs` (done).
- `src/kimi_cli/session.py` → `rust/kagent/src/session.rs` (done).
- `src/kimi_cli/share.py` → `rust/kagent/src/share.rs` (done).
- `src/kimi_cli/skill/*` → `rust/kagent/src/skill/*` (done).
- `src/kimi_cli/soul/*` → `rust/kagent/src/soul/*` (done).
- `src/kimi_cli/tools/*` → `rust/kagent/src/tools/*` (done except **gap**: `tools/test.py`).
- `src/kimi_cli/tools/display.py` → `rust/kosong/src/tooling/mod.rs` display blocks (done).
- `src/kimi_cli/wire/*` → `rust/kagent/src/wire/*` (done).
- `src/kimi_cli/ui/wire/*` → `rust/kagent/src/ui/wire/*` (done).
- `src/kimi_cli/ui/shell/*`, `src/kimi_cli/ui/print/*`, `src/kimi_cli/acp/*` → intentionally omitted.
- `src/kimi_cli/platforms.py` → shell UI only; intentionally omitted.

### 10.2 kimi-cli utils (Python → Rust)

Used by core runtime/tools and ported:
- `utils/aioqueue.py` → `rust/kagent/src/utils/aioqueue.rs`.
- `utils/broadcast.py` → `rust/kagent/src/utils/broadcast.rs`.
- `utils/diff.py` → `rust/kagent/src/utils/diff.rs`.
- `utils/environment.py` → `rust/kagent/src/utils/environment.rs`.
- `utils/frontmatter.py` → `rust/kagent/src/utils/frontmatter.rs`.
- `utils/message.py` → `rust/kagent/src/utils/message.rs`.
- `utils/path.py` → `rust/kagent/src/utils/path.rs`.
- `utils/slashcmd.py` → `rust/kagent/src/utils/slashcmd.rs`.
- `utils/string.py` → `rust/kagent/src/utils/string.rs`.

Intentionally omitted or replaced:
- `utils/aiohttp.py` → replaced by `reqwest` usage in Rust tools.
- `utils/logging.py` → **gap**: no Rust logging setup yet (see 10.4).
- `utils/typing.py` → no direct need in Rust; serde replaces union flattening.
- `utils/changelog.py`, `clipboard.py`, `datetime.py`, `envvar.py`, `pyinstaller.py`,
  `rich/*`, `signals.py`, `term.py` → UI/packaging only; intentionally omitted.

### 10.3 kosong core (Python → Rust)

- `message.py` → `rust/kosong/src/message.rs` (done; serde parity).
- `tooling/*` → `rust/kosong/src/tooling/*` (done; schema + display blocks).
- `chat_provider/kimi.py` → `rust/kosong/src/chat_provider/kimi.rs` (done).
- `chat_provider/echo/*` → `rust/kosong/src/chat_provider/echo/*` (done).
- `chat_provider/chaos.py`, `chat_provider/mock.py`, `chat_provider/openai_common.py`,
  `contrib/*` → intentionally omitted (non‑Kimi providers and contrib features).
- `utils/jsonschema.py` → `rust/kosong/src/utils/jsonschema.rs` (done).
- `utils/typing.py` → `rust/kosong/src/utils/typing.rs` (done).
- `utils/aio.py` → no direct Rust equivalent required.

### 10.4 kaos core (Python → Rust)

- `local.py` → `rust/kaos/src/local.rs` (done).
- `path.py` → `rust/kaos/src/path.rs` (done).
- `_current.py` → `rust/kaos/src/current.rs` (done).
- `ssh.py` → intentionally omitted for this phase.

### 10.5 New gaps to address (from audit)

1. **Missing test tools**: `src/kimi_cli/tools/test.py` has no Rust equivalent or registry entry.
   - Status: implemented (`rust/kagent/src/tools/test.rs`) + loader wiring.
2. **Logging parity**: Rust CLI parses `--debug/--verbose` but no logging setup or file output.
   - Status: logging init added (`utils/logging.rs`) + basic config/provider/thinking logs.
   - Remaining: add more structured logs in soul/toolset/session if needed.
3. **Tool key argument fallback**: Rust `extract_key_argument` drops unknown tools on JSON parse
   failure; Python returns raw JSON content for unknown tools (esp. streaming args).
   - Status: implemented fallback for unknown tool names.

---

## 11. Wire E2E Expansion Plan (2025-02-14)

Goal: add Rust e2e coverage for the missing major user-facing paths (wire mode), aligned with
Python behavior but isolated to temp share dirs and deterministic ScriptedEcho scripts.

### 11.1 Test Harness Enhancements

- Add helper utilities in `rust/kagent/tests/e2e_test_utils.rs`:
  - Read and classify stdout lines into JSON-RPC responses/events/requests.
  - Helpers to respond to `ApprovalRequest` and `ToolCallRequest` messages.
  - Minimal polling loop to wait for a response ID while servicing incoming requests.
- Keep helpers synchronous (BufRead + std::process) to match existing e2e tests.
- Ensure `HOME`/`USERPROFILE` point to temp dirs so share data lands under `~/.kimi`.

### 11.2 Skills + Flows E2E

- Create temp skills directory with:
  - Standard skill: `demo/ SKILL.md` with simple frontmatter and body text.
  - Flow skill: `flow-demo/ SKILL.md` with `type: flow` and mermaid code block.
- Use `--skills-dir` to override discovery; `--work-dir` set to temp.
- ScriptedEcho scripts:
  - Turn 1 (skill): return `text: Skill executed`.
  - Turn 2+ (flow): return `text: Flow step 1` then `text: Flow done`.
- Assert:
  - `/skill:demo` triggers completion with expected text event.
  - `/flow:flow-demo` emits multiple `TurnBegin` events (flow steps).
  - Final response status is `finished`.

### 11.3 External Tools + Parallel Tool Calls

- Register external tools via `initialize`:
  - `ext_sum` with JSON schema.
  - `ext_echo` with JSON schema.
- Use custom agent file that includes test tools (`kimi_cli.tools.test:Plus`, `Compare`)
  to avoid approvals.
- ScriptedEcho scripts:
  - Turn 1: two tool calls in one response (one internal, one external) to validate parallel
    tool dispatch; then a follow-up text message.
- Assert:
  - Wire `ToolCallRequest` is emitted for external tool and handled by test responder.
  - Two tool results are observed and follow-up text is emitted.

### 11.4 Approval Flow E2E

- Run without `--yolo` and use a tool that requires approval (Shell or WriteFile).
- ScriptedEcho script emits tool call.
- Test harness responds to ApprovalRequest with Approve or Reject.
- Assert:
  - ApprovalRequest is issued over wire.
  - Tool result is produced (or tool rejected content observed).

### 11.5 Built-in Tools + Task/Subagent E2E

- Use custom agent file to include:
  - `SendDMail`, `Think`, `CreateSubagent`, `Task`, plus file/web/todo/shell tools.
  - Subagent definition (simple scripted provider).
- ScriptedEcho scripts:
  - Built-in tool call sequence: ReadFile → WriteFile → StrReplaceFile → Glob → Grep
    → SetTodoList → Think → SendDMail (checkpoint 0) → final text.
  - For Task tool: use subagent `coder` and assert SubagentEvent emissions.
- Assert:
  - File outputs exist in work dir and content changes applied.
  - SubagentEvent is observed for Task tool.
  - DMail triggers a subsequent scripted step and ends successfully.

### 11.6 Session Restore + Agent File E2E

- Run once with explicit `--session` ID and custom agent file; ensure context file exists.
- Run again with the same session ID; verify context file grows (more JSONL lines).
- Assert:
  - Session data resides under temp `HOME/.kimi`.
  - Second run appends to the same context file (non-zero delta).

### 11.7 MCP E2E (Local HTTP)

- Use rmcp server-side transport with an in-test HTTP server:
  - Create a minimal MCP server with a single tool (e.g., `sum`).
  - Serve via `StreamableHttpService` on an ephemeral port.
- Provide MCP config (`--mcp-config`) pointing to the server URL.
- ScriptedEcho emits a tool call to the MCP tool and a follow-up text.
- Assert:
  - MCP tool registered and executed; tool result content appears in events.
  - Server shutdown is clean after test.

### 11.8 Error Handling E2E

- CLI argument errors:
  - Launch without `--wire` and assert non-zero exit.
  - Launch with conflicting flags (`--agent` + `--agent-file`) and assert non-zero exit.
- LLM errors:
  - Use scripted echo with invalid DSL or exhausted scripts to force provider error.
  - Assert JSON-RPC error code `-32003` and message includes provider error.

---

## 12. Module Rescan & Parity Audit (current run)

Goal: re-examine all core modules and tests to ensure complete parity with Python behavior and
the Chinese docs. Record and fix any deltas before proceeding with new feature work.

### 12.1 Scope and inputs

- **Python core scope**:
  - `src/kimi_cli/{config,metadata,session,agentspec,app,llm}`
  - `src/kimi_cli/soul/*`
  - `src/kimi_cli/wire/*` and `src/kimi_cli/ui/wire/*`
  - `src/kimi_cli/tools/*` (excluding UI-only tool docs)
  - `packages/kosong/src/kosong/{message,tooling,chat_provider/{kimi,echo},_generate,utils}`
  - `packages/kaos/src/kaos/{local,path,_current}` (exclude `ssh.py`)
  - Tests under `tests/` and `tests_ai/` except UI/shell/non-Kimi providers
- **Rust target scope**:
  - `rust/kagent/src/*`
  - `rust/kosong/src/*`
  - `rust/kaos/src/*`
  - `rust/kagent/tests/*`, `rust/kosong/tests/*`, `rust/kaos/tests/*`
- **Behavioral source of truth**:
  - `docs/zh/**` for user-facing behavior
  - Python runtime behavior for edge cases and error messages

### 12.2 Audit checklist (must verify)

- **Wire protocol**:
  - Envelope `type` field matches Python class names.
  - JSON-RPC error codes and messages align with docs.
  - `ApprovalRequestResolved` compatibility maintained.
  - `initialize` tool registration and response validation parity.
- **Kosong message + tooling**:
  - `Message.content` serde rules (string vs parts array) match exactly.
  - `ToolCall` and `ToolCallPart` merge semantics identical to Python.
  - `ToolReturnValue` display blocks round-trip with unknown block fallback.
- **Soul loop**:
  - Compaction trigger, prompt injection, and context file rotation.
  - Approval workflow and tool rejection text.
  - Ralph loop: stop/continue logic and replay handling.
  - DMail checkpoint rewind and usage tracking.
- **Tools**:
  - Schemas/descriptions match Python (including defaults and optional fields).
  - Output truncation rules and display blocks are identical.
  - Grep/glob behavior matches Python (rg flags, glob rules, path normalization).
  - Web tool headers, error messages, and content extraction parity.
- **Config/session/metadata**:
  - TOML/JSON migration behavior; env overrides.
  - Session loading and context JSONL format.
  - Share dir layout under `~/.kimi`.
- **Kaos**:
  - LocalKaos async file IO + process exec parity.
  - KaosPath expansions and canonicalization.
- **CLI**:
  - Flag set matches Python (excluding Print/Shell/ACP).
  - Wire-only mode errors match Python wording.
- **Docs alignment**:
  - WireOverStdio behavior matches `docs/zh/customization/wire-mode.md`.
  - MCP CLI behavior matches `docs/zh/reference/kimi-mcp.md`.

### 12.3 Execution steps

1. **Module inventory**:
   - Enumerate Python and Rust module lists (rg files).
   - Map 1:1 coverage, list gaps.
2. **Focused diff review**:
   - For each core module, compare Python vs Rust behavior.
   - Document deltas in a short parity log (append to this plan).
3. **Targeted fixes**:
   - Address any mismatches found (code + tests).
   - Ensure all IO remains async.
4. **Verification**:
   - Run `cargo test` for all crates.
   - Re-run any modified tests if failures are isolated.
5. **Sign-off**:
   - Update `Progress` with completed audit and remaining gaps (if any).

### 12.4 Rescan log (current run)

- Module inventory: captured file lists for `src/kimi_cli`, `packages/kosong/src/kosong`,
  `packages/kaos/src/kaos`, `rust/kagent/src`, `rust/kosong/src`, `rust/kaos/src`.
- Wire JSON-RPC parity: aligned UTF-8 handling (lossy), invalid response handling, method-not-found
  error messages, invalid params messaging, and shutdown cleanup to match Python.
- External tools: aligned builtin conflict detection and rejection reason in wire initialize flow.
- Config serialization: skip `None` fields to match Python `exclude_none`; aligned JSON vs TOML error
  messages and validation error wrapping for config text/file and legacy migration.
- Tool result messaging: added ToolRuntimeError-style warning line using brief display block match.
- Context persistence: matched Python `exclude_none=True` by stripping nulls when writing JSONL
  messages to context files.

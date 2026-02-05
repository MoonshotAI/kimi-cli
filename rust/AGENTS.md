# KAgent (Rust)

## Quick commands (cargo)

- `cargo build -p kagent`
- `cargo test -p kagent`
- `cargo test -p kosong`
- `cargo test -p kaos`
- `cargo test` (workspace)
- `cargo fmt`
- `cargo clippy --workspace --all-targets`

## Purpose and naming

KAgent is the Rust rewrite of the Python `kimi-cli` runtime. It is a wire-only agent server
(no Shell/Print/ACP UI) and lives under `rust/`. The binary name is `kagent`, but the wire
protocol identity stays aligned with Python:

- Wire metadata and user-agent still identify as "Kimi Code CLI" / `KimiCLI/<VERSION>`.
- Tool identifiers remain `kimi_cli.tools.*` for compatibility.
- The CLI `about` string is "KAgent, the Kimi agent server."

## Sync contract with Python (must-follow)

The Rust and Python implementations must stay in lockstep for any external behavior:

- Wire protocol, message envelopes, error codes (`docs/zh/customization/wire-mode.md`).
- `kosong.message` and `kimi_cli.wire.types` schemas and serde behavior.
- Config, metadata, sessions, and context JSONL formats under `~/.kimi`.
- Agent specs, prompts, skills/flows, tool schemas/descriptions, approvals, compaction.
- Providers and Kaos behavior (Kimi/Echo/ScriptedEcho, LocalKaos).
- Internal IDs and names that appear on the wire must remain stable.

When in doubt, Python (`src/kimi_cli`, `packages/kosong`, `packages/kaos`) and `docs/zh/`
are the source of truth, and both sides should change together.

## Rewrite constraints (from rust/_/PROMPT.md and rust/_/PLAN.md)

- Three crates: `kagent`, `kosong`, `kaos`.
- Rust edition 2024, async runtime `tokio`, serde, anyhow/thiserror, clap, reqwest.
- Only WireOverStdio UI; no Shell/Print/ACP UI.
- Full parity with Python for data formats and wire behavior.
- Tests are ported for core runtime/tools/wire; UI-only tests are omitted.

## Workspace layout

- `rust/kagent/` - main crate (binary: `kagent`), wire-only agent server.
- `rust/kosong/` - LLM abstraction layer (messages, tooling, providers).
- `rust/kaos/` - OS abstraction layer (LocalKaos + path semantics).

## CLI behavior (kagent)

- Wire-only server; no UI selection flags.
- `--wire` exists but is hidden and ignored (legacy compatibility).
- No `--prompt`/`--command` because wire server does not accept an initial prompt.
- Subcommands: `info`, `mcp` only.
- Help text mirrors Python; some MCP examples still show `kimi` for parity.

## Known incompatibilities with Python

- MCP OAuth credentials location differs from Python fastmcp defaults; Rust uses `rmcp`
  credential storage paths and is not compatible with fastmcp token locations.
- Options kept for parity: `--work-dir`, `--session`, `--continue`, `--config`,
  `--config-file`, `--model`, `--thinking/--no-thinking`, `--yolo`, `--agent`,
  `--agent-file`, `--mcp-config-file`, `--mcp-config`, `--skills-dir`,
  `--max-steps-per-turn`, `--max-retries-per-step`, `--max-ralph-iterations`.
- `help_expected` is enabled in clap, so every CLI arg must define help text.

## Major Rust modules (kagent)

- `rust/kagent/src/cli/` - CLI parsing and subcommands (`info`, `mcp`).
- `rust/kagent/src/app.rs` - `KimiCLI::create` and runtime wiring.
- `rust/kagent/src/soul/` - core agent loop, approvals, compaction, context, toolset.
- `rust/kagent/src/wire/` - wire types, serde, WireOverStdio JSON-RPC server.
- `rust/kagent/src/tools/` - built-in tools (shell/file/web/todo/multiagent/dmail/think).
- `rust/kagent/src/skill/` - skills + flow parsing (mermaid/d2).
- `rust/kagent/src/config.rs`, `metadata.rs`, `session.rs`, `share.rs` - persistence.
- `rust/kagent/src/mcp.rs` - MCP config + loading (rmcp client).

## Wire protocol and data compatibility

- Wire protocol version `1.1` with JSON-RPC over stdio.
- Data layout under `~/.kimi` must match Python:
  - `config.toml`, `kimi.json`, session directories, context JSONL, wire JSONL.
- `Message.content` string/parts serde rules must match Python exactly.

## Providers and tools

- Providers: Kimi, Echo, ScriptedEcho (Echo variants used for tests).
- Kaos: LocalKaos only (SSH Kaos omitted for now).
- Built-in tools: Shell, Read/Write/Replace/Glob/Grep/ReadMedia, SearchWeb/FetchURL,
  SetTodoList, CreateSubagent, Task, SendDMail, Think; test tools Plus/Compare/Panic.
- Tool descriptions live under `rust/kagent/src/tools/desc/` and must match Python.

## MCP integration

- MCP config: `~/.kimi/mcp.json`, same schema as Python.
- Client: `rmcp` with stdio + HTTP transports, OAuth storage compatibility.
- CLI: `kagent mcp add/list/remove/auth/reset-auth/test`.

## Tests

- Rust tests live under `rust/kagent/tests`, `rust/kosong/tests`, `rust/kaos/tests`.
- E2E tests cover wire-mode behavior using ScriptedEcho and mock services.
- Run Python E2E against Rust after building the binary:
  - `cargo build -p kagent`
  - `KIMI_E2E_WIRE_CMD=./rust/target/debug/kagent uv run pytest tests_e2e`

## Conventions and runtime rules

- Prefer async I/O in runtime code; avoid blocking locks in async contexts.
- Keep prompts, schemas, error strings, and wire payloads aligned with Python.
- If any behavior or documented interface changes, update this file and the
  corresponding Python implementation and tests.

## Pointers for future updates

- `rust/_/PROMPT.md` defines the rewrite scope and compatibility constraints.
- `rust/_/PLAN.md` records the parity plan and progress; treat it as historical context.
- Always validate against the actual Rust code and Python behavior when in conflict.

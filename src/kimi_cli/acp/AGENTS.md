# ACP Integration Notes (kimi-cli)

## Protocol summary (ACP overview)
- ACP is JSON-RPC 2.0 with request/response methods plus one-way notifications.
- Typical flow: `initialize` -> optional `authenticate` -> `session/new` or `session/load`
  -> `session/prompt`
  with `session/update` notifications and optional `session/cancel`.
- Clients provide `session/request_permission` and optional terminal/filesystem methods.
- All ACP file paths must be absolute; line numbers are 1-based.

## Entry points and server modes
- **Single-session server**: `KimiCLI.run_acp()` uses `ACP` -> `ACPServerSingleSession`.
  - Code: `src/kimi_cli/app.py`, `src/kimi_cli/ui/acp/__init__.py`.
  - Used when running CLI with `--acp` UI mode.
- **Multi-session server**: `acp_main()` runs `ACPServer` with `use_unstable_protocol=True`.
  - Code: `src/kimi_cli/acp/__init__.py`, `src/kimi_cli/acp/server.py`.
  - Exposed via the `kimi acp` command in `src/kimi_cli/cli.py`.

## Capabilities advertised
- `prompt_capabilities`: `embedded_context=False`, `image=True`, `audio=False`.
- `mcp_capabilities`: `http=True`, `sse=False`.
- Single-session: `load_session=False`, no session list capabilities.
- Multi-session: `load_session=True`, `session_capabilities.list` supported.
- `auth_methods=[]` (no authentication methods advertised).

## Session lifecycle (implemented behavior)
- `session/new`
  - Multi-session: creates a persisted `Session`, builds `KimiCLI`, stores `ACPSession`.
  - Single-session: wraps the existing `Soul` into a `Wire` loop and creates `ACPSession`.
  - Both send `AvailableCommandsUpdate` for slash commands on session creation.
  - MCP servers passed by ACP are converted via `acp_mcp_servers_to_mcp_config`.
- `session/load`
  - Multi-session only: loads by `Session.find`, then builds `KimiCLI` and `ACPSession`.
  - No history replay yet (TODO).
  - Single-session: not implemented.
- `session/list`
  - Multi-session only: lists sessions via `Session.list`, no pagination.
  - Single-session: not implemented.
- `session/prompt`
  - Uses `ACPSession.prompt()` to stream updates and produce a `stop_reason`.
  - Stop reasons: `end_turn`, `max_turn_requests`, `cancelled`.
- `session/cancel`
  - Sets the per-turn cancel event to stop the prompt.

## Streaming updates and content mapping
- Text chunks -> `AgentMessageChunk`.
- Think chunks -> `AgentThoughtChunk`.
- Tool calls:
  - Start -> `ToolCallStart` with JSON args as text content.
  - Streaming args -> `ToolCallProgress` with updated title/args.
  - Results -> `ToolCallProgress` with `completed` or `failed`.
  - Tool call IDs are prefixed with turn ID to avoid collisions across turns.
- Plan updates:
  - `TodoDisplayBlock` is converted into `AgentPlanUpdate`.
- Available commands:
  - `AvailableCommandsUpdate` is sent right after session creation.

## Prompt/content conversion
- Incoming prompt blocks:
  - Supported: `TextContentBlock`, `ImageContentBlock` (converted to data URL).
  - Unsupported types are logged and ignored.
- Tool result display blocks:
  - `DiffDisplayBlock` -> `FileEditToolCallContent`.
  - `HideOutputDisplayBlock` suppresses tool output in ACP (used by terminal tool).

## Tool integration and permission flow
- ACP sessions use `ACPKaos` to route filesystem reads/writes through ACP clients.
- If the client advertises `terminal` capability, the `Shell` tool is replaced by an
  ACP-backed `Terminal` tool.
  - Uses ACP `terminal/create`, waits for exit, streams `TerminalToolCallContent`,
    then releases the terminal handle.
- Approval requests in the core tool system are bridged to ACP
  `session/request_permission` with allow-once/allow-always/reject options.

## Current gaps / not implemented
- `authenticate` method (not used by current Zed ACP client).
- `session/set_mode` and `session/set_model` (no multi-mode/model switching in kimi-cli).
- `ext_method` / `ext_notification` for custom ACP extensions are stubbed.
- Single-session server does not implement `session/load` or `session/list`.

## Filesystem (ACP client-backed)
- When the client advertises `fs.readTextFile` / `fs.writeTextFile`, `ACPKaos` routes
  reads and writes through ACP `fs/*` methods.
- `ReadFile` uses `KaosPath.read_lines`, which `ACPKaos` implements via ACP reads.
- `WriteFile` uses `KaosPath.read_text/write_text/append_text` and still generates diffs
  and approvals in the tool layer.

## Zed-specific notes (as of current integration)
- Zed does not currently call `authenticate`.
- Zed’s external agent server session management is not yet available, so
  `session/load` is not exercised in practice.

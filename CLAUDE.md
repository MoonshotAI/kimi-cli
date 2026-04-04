Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Project Overview

Kimi Code CLI (`kimi-cli`) is an AI-powered terminal agent with two parallel implementations:

- **Python version** (`src/kimi_cli/`, v1.30.0): The original implementation, run via `uv run kimi`
- **TypeScript version** (`src/kimi_cli_ts/`, v2.0.0): The Bun-based port, run via `bun run start`

The TS version is actively being aligned to match the Python version's features and interactions (see `PLAN.md` for the diff checklist).

## Architecture

Both versions share the same layered architecture:

```
CLI (cli/)  →  App (app.py/ts)  →  Soul (soul/)  →  LLM (llm.py/ts)
                    ↓                    ↓
               Runtime/Agent         Tools (tools/)
                    ↓                    ↓
              Session (session.py/ts)  Wire (wire/)
```

### Core Modules

| Module | Python | TypeScript | Description |
|--------|--------|------------|-------------|
| Entry point | `__main__.py` | `index.ts` | CLI entrypoint, delegates to `cli/` |
| App orchestrator | `app.py` | `app.ts` | `KimiCLI` factory: wires config → LLM → runtime → agent → soul |
| Config | `config.py` | `config.ts` | TOML/JSON config loading, Pydantic/Zod validation. Config at `~/.kimi/config.toml` |
| LLM | `llm.py` | `llm.ts` | Multi-provider LLM abstraction (Kimi, OpenAI, Anthropic, Gemini, VertexAI) |
| Session | `session.py` | `session.ts` | Session persistence (create/continue/restore), session state, wire file |
| Constants | `constant.py` | `constant.ts` | `NAME`, `VERSION`, `USER_AGENT` |

### Soul Layer (`soul/`)

The "soul" is the agent reasoning core:

- **`kimisoul.py/ts`** — `KimiSoul`: main orchestrator for LLM interaction loop, plan mode, slash commands, compaction, dynamic injections
- **`agent.py/ts`** — `Agent`, `Runtime`: agent spec loading, runtime context (config, LLM, session, toolset, hooks, skills, subagents, MCP)
- **`context.py/ts`** — `Context`: conversation history persistence and restore
- **`toolset.py/ts`** — `KimiToolset`: tool registration, MCP integration, tool call dispatch with hooks
- **`compaction.py/ts`** — Auto-compaction when context exceeds token limits
- **`approval.py/ts`** — Tool execution approval flow
- **`slash.py/ts`** — Slash command registry
- **`dynamic_injection.py/ts`** — Dynamic system prompt injection (plan mode, yolo mode, etc.)
- **`denwarenji.py/ts`** — Phone chain / subagent communication
- **`message.py/ts`** — Message construction helpers

### Tools (`tools/`)

Built-in tool implementations organized by category:

- `shell/` — Shell command execution
- `file/` — File read/write/edit/glob/grep
- `web/` — Web search and fetch
- `agent/` — Subagent spawning
- `ask_user/` — User interaction tool
- `plan/` — Plan mode tools
- `think/` — Thinking/reasoning tool
- `todo/` — Task management
- `background/` — Background task management
- `dmail/` — Direct message between agents
- `display.py/ts` — Display/output formatting

Tools are registered via `tools/` module and listed in agent spec YAML files.

### Agent Specs (`agents/`)

YAML-based agent definitions at `src/kimi_cli/agents/`:

- `default/agent.yaml` — Default agent configuration (tools list, system prompt template, subagent definitions)
- `okabe/agent.yaml` — Alternative agent config
- Agent specs support inheritance via `extend` field
- System prompts are Jinja2 templates with builtin variables (`KIMI_NOW`, `KIMI_WORK_DIR`, `KIMI_OS`, etc.)

### Subagents (`subagents/`)

Multi-agent orchestration system:

- `models.py/ts` — `AgentTypeDefinition`, `ToolPolicy`
- `registry.py/ts` — `LaborMarket`: agent type registration and discovery
- `builder.py/ts` — Subagent instance builder
- `runner.py/ts` — Subagent execution runner
- `store.py/ts` — Subagent instance state persistence
- `core.py/ts` — Core subagent logic
- `git_context.py/ts` — Git context for subagents

### Skills (`skill/`, `skills/`)

- `skill/` — Skill loading, indexing, discovery from `~/.kimi/skills/`, `.kimi/skills/`, `.claude/skills/`
- `skill/flow/` — Skill flow graph (choice-based skill routing)
- `skills/` — Built-in skills (e.g., `kimi-cli-help`, `skill-creator`)

### Wire Protocol (`wire/`)

Communication layer between soul and UI:

- `types.py/ts` — Wire message types (StepBegin, ToolCall, ToolResult, StatusUpdate, ApprovalRequest, etc.)
- `protocol.py/ts` — Wire protocol definition
- `serde.py/ts` — Serialization/deserialization
- `file.py/ts` — Wire message file persistence
- `server.py/ts` — Wire server (stdio)
- `root_hub.py/ts` — Message hub for multi-agent wire routing
- `jsonrpc.py/ts` — JSON-RPC transport

### UI Layer (`ui/`)

- **Python**: `shell/` (prompt_toolkit TUI), `print/` (non-interactive), `acp/` (Agent Client Protocol server)
- **TypeScript**: `shell/` (React Ink TUI), `print/` (non-interactive), `components/` (Ink components), `hooks/` (React hooks)

### Other Modules

- `auth/` — OAuth authentication (`oauth.py/ts`), platform detection (`platforms.py/ts`)
- `hooks/` — Event hook system (PreToolUse, PostToolUse, Stop, SessionStart, etc.)
- `plugin/` — Plugin management (MCP-based plugins)
- `background/` — Background task manager
- `notifications/` — Notification system
- `approval_runtime/` — Approval state management
- `cli/` — CLI argument parsing (Python: Typer, TS: Commander)
- `share.py` / `config.ts:getShareDir()` — Share directory (`~/.kimi/`)
- `metadata.py/ts` — Work directory metadata
- `exception.py/ts` — Custom exception types

## Key Patterns

### Python Version

- **Async throughout**: Uses `asyncio`, `AsyncGenerator` patterns
- **Pydantic models** for config validation and data classes
- **`@dataclass(slots=True)`** for domain objects
- **`kosong`** framework: `ChatProvider`, `Toolset`, `Tool`, `Message` abstractions
- **`kaos`** for async path operations (`KaosPath`)
- **`loguru`** for logging via `kimi_cli.utils.logging.logger`
- **Jinja2** for system prompt templates
- **YAML** for agent specs
- **prompt-toolkit** for shell TUI
- **Package manager**: `uv` (see `pyproject.toml`)
- **Linting**: `ruff`
- **Type checking**: `pyright` / `ty`
- **Testing**: `pytest` + `pytest-asyncio`

### TypeScript Version

- **Bun runtime**: Uses Bun APIs (`Bun.file`, `Bun.write`, `Bun.$`, `Bun.serve`)
- **Zod v4** for config validation (corresponds to Python Pydantic)
- **React Ink** for shell TUI (corresponds to Python prompt-toolkit)
- **Commander** for CLI parsing (corresponds to Python Typer)
- **`@iarna/toml`** for TOML parsing
- **Linting/formatting**: Biome
- **Type checking**: `tsc --noEmit`
- **Testing**: `bun test`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `KIMI_BASE_URL` | Override API base URL |
| `KIMI_API_KEY` | Override API key |
| `KIMI_MODEL_NAME` | Override model name |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | Override max context size |
| `KIMI_MODEL_CAPABILITIES` | Override model capabilities (comma-separated) |
| `KIMI_MODEL_TEMPERATURE` | Override temperature |
| `KIMI_MODEL_TOP_P` | Override top_p |
| `KIMI_MODEL_MAX_TOKENS` | Override max tokens |
| `KIMI_SHARE_DIR` | Override share directory (default: `~/.kimi/`) |
| `OPENAI_BASE_URL` | Override OpenAI base URL (for openai providers) |
| `OPENAI_API_KEY` | Override OpenAI API key (for openai providers) |

## Config File

Located at `~/.kimi/config.toml`. Supports TOML (preferred) and JSON (legacy, auto-migrated).

Key fields: `default_model`, `default_thinking`, `default_yolo`, `default_plan_mode`, `theme`, `models`, `providers`, `loop_control`, `hooks`, `services`, `background`, `mcp`.

## Running

```bash
# Python version
uv run kimi

# TypeScript version
bun run start          # or: bun run src/kimi_cli_ts/index.ts
bun run dev            # watch mode
bun run build          # compile to binary

# Tests
pytest                 # Python tests
bun test               # TypeScript tests

# Lint & format
ruff check src/        # Python lint
biome check src/       # TypeScript lint
biome format --write src/  # TypeScript format
```

## Testing

Python tests are in `tests/` using pytest. TypeScript tests use `bun test` with `.test.ts` files.

```bash
# Run all Python tests
uv run pytest

# Run specific test file
uv run pytest tests/test_xxx.py

# Run all TS tests
bun test

# Run specific TS test
bun test tests/xxx.test.ts
```

## Conventions

- Python and TypeScript modules have 1:1 correspondence (same file names, same class/function names in camelCase/snake_case)
- Wire message types are shared between both versions
- Agent specs (YAML) are shared between both versions
- Config format (TOML) is shared between both versions
- When modifying one version, consider whether the same change is needed in the other

## Renderer: Terminal Text Selection Fix

### Problem

React Ink's rendering destroys terminal mouse text selection. When output height >= `stdout.rows`, Ink switches to a "clearTerminal" code path that emits `\x1b[2J` (erase screen) + `\x1b[3J` (erase scrollback) + `\x1b[H` (cursor home) + full content every frame at ~12fps. The `\x1b[2J` wipes all terminal selection state.

### Root Cause Chain

1. `Shell.tsx` had `<Box minHeight={termHeight}>` making output always fill the terminal
2. Ink checks `if (this.lastOutputHeight >= this.options.stdout.rows)` in `ink.js:322`
3. When true, Ink uses `ansiEscapes.clearTerminal + fullStaticOutput + output` instead of incremental diff
4. `clearTerminal` = `\x1b[2J\x1b[3J\x1b[H]` which destroys selection and scrollback

### Solution (two layers)

**Layer 1 — Shell.tsx**: Changed root `<Box>` from `minHeight={termHeight}` to `height={termHeight - 1}`. This forces Yoga to constrain the layout to exactly `rows - 1` lines, so Ink's `lastOutputHeight >= stdout.rows` check is always false. Ink then uses its incremental diff path (eraseLines + overwrite changed lines only). `<Static>` messages naturally flow into scrollback and are never re-drawn.

**Layer 2 — `ui/renderer/index.ts`**: Wraps `stdout.write` to intercept frames that still hit the clearTerminal path (when content grows beyond terminal height):

- Strips `\x1b[2J` and `\x1b[3J` from output
- Rewrites content using CUP absolute positioning (`\x1b[row;1H`) per line instead of `\n`
- Shows the last N lines (N = terminal rows) so statusbar/input stay visible
- Zero `\n` emission = no scrollback pollution
- On DEC 2026 terminals, merges BSU/ESU into single atomic `stdout.write()`

### Key Files

| File | Role |
|------|------|
| `src/kimi_cli_ts/ui/renderer/index.ts` | stdout.write wrapper, CUP rewrite, BSU/ESU merge |
| `src/kimi_cli_ts/ui/renderer/terminal-detect.ts` | DEC 2026 terminal detection |
| `src/kimi_cli_ts/ui/shell/Shell.tsx` | Removed `minHeight={termHeight}` |
| `src/kimi_cli_ts/cli/index.ts` | Calls `patchInkLogUpdate()` before Ink render |

### Debug

The renderer writes `renderer-debug.log` in the working directory. Use `tail -f renderer-debug.log` to monitor. Key log markers:

- `STRIP!` — a clearTerminal frame was intercepted and rewritten as CUP
- `FRAME#` — a BSU/ESU-wrapped frame (DEC 2026 terminal)
- `NOSYNC` — a write outside BSU/ESU (non-DEC-2026 terminal, e.g. tmux)
- `eraseLn*` — Ink's normal incremental diff (good, means selection-safe path)
- `ERASE_SCREEN!` — should never appear in output (means strip failed)

### Constraints

- Bun cannot monkey-patch Ink's ESM `log-update.js` module (ESM default exports are read-only in Bun's require)
- tmux does not support DEC 2026 synchronized output, so BSU/ESU are passed through individually
- The renderer library files under `ui/renderer/` (screen.ts, diff.ts, ansi-parser.ts, patch-writer.ts, etc.) are infrastructure for future cell-level diffing but are not actively used in the current solution

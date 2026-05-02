# Kimi Code CLI

## Quick commands (use uv)

- `make prepare` (sync deps for all workspace packages and install git hooks)
- `make format`
- `make check`
- `make test`
- `make ai-test`
- `make build` / `make build-bin`

If running tools directly, use `uv run ...`.

## Project overview

Kimi Code CLI is a Python CLI agent for software engineering workflows. It supports an interactive
shell UI, ACP server mode for IDE integrations, and MCP tool loading.

## LLM Provider Configuration

### Default model

The default model is `kimi-for-coding` (beta preview), served through the **agent gateway**.

### Agent Gateway

When the provider `base_url` contains `agent-gw.kimi.com`, the CLI automatically switches from
OpenAI Chat Completions format to **Anthropic Messages API** format. This is handled transparently
in `src/kimi_cli/llm.py`.

```toml
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 2000000
capabilities = ["video_in", "image_in", "thinking"]

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://agent-gw.kimi.com/coding/v1"
api_key = "sk-kimi-..."
```

### API format details

| Endpoint | Method | Format |
|----------|--------|--------|
| `/coding/v1/messages` | POST | Anthropic Messages API |
| `/coding/v1/models` | GET | OpenAI-compatible list |
| `/coding/v1/usages` | GET | Platform quota info |
| `/coding/v1/feedback` | POST | Feedback submission |

The Anthropic SDK appends `/v1/messages` to the base URL. The CLI strips the trailing `/v1`
from `base_url` before passing it to the Anthropic client when `agent-gw` is detected.

### Environment overrides

| Variable | Effect |
|----------|--------|
| `KIMI_BASE_URL` | Overrides provider `base_url` |
| `KIMI_API_KEY` | Overrides provider `api_key` |
| `KIMI_MODEL_NAME` | Overrides model name |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | Overrides `max_context_size` |
| `KIMI_MODEL_TEMPERATURE` | Sets generation temperature |
| `KIMI_MODEL_TOP_P` | Sets top-p sampling |
| `KIMI_MODEL_MAX_TOKENS` | Sets max output tokens |

### Model capabilities (kimi-for-coding)

- **Architecture**: MoE, 1T params (32B active)
- **Context**: 262,144 tokens (reported by API) / up to 2M (configurable)
- **Input**: text, image, video
- **Reasoning**: thinking/reasoning content supported
- **Embeddings**: `bge_m3_embed`, 1024-dim via `/coding/v1/embeddings`
- **Training cutoff**: January 2025

### Preserving custom base URLs on login

When running `/login`, the OAuth flow normally overwrites the provider config with the platform's
hardcoded `api.kimi.com` URL. The CLI now preserves an existing custom `base_url` (e.g.
`agent-gw.kimi.com`) during login, so the agent gateway setting is not lost.

## Tech stack

- Python 3.12+ (tooling configured for 3.14)
- CLI framework: Typer
- Async runtime: asyncio
- LLM framework: kosong
- MCP integration: fastmcp
- Logging: loguru
- Package management/build: uv + uv_build; PyInstaller for binaries
- Tests: pytest + pytest-asyncio; lint/format: ruff; types: pyright + ty

## Architecture overview

- **CLI entry**: `src/kimi_cli/cli/__init__.py` (Typer) parses flags (UI mode, agent spec, config, MCP)
  and routes into `KimiCLI` in `src/kimi_cli/app.py`.
- **App/runtime setup**: `KimiCLI.create` loads config (`src/kimi_cli/config.py`), chooses a
  model/provider (`src/kimi_cli/llm.py`), builds a `Runtime` (`src/kimi_cli/soul/agent.py`),
  loads an agent spec, restores `Context`, then constructs `KimiSoul`.
- **Agent specs**: YAML under `src/kimi_cli/agents/` loaded by `src/kimi_cli/agentspec.py`.
  Specs can `extend` base agents, select tools by import path, and register builtin subagent
  types via the `subagents` field. Subagent instances are persisted separately under the session
  directory and can be resumed by `agent_id`. System prompts live alongside specs; builtin args
  include `KIMI_NOW`, `KIMI_WORK_DIR`, `KIMI_WORK_DIR_LS`, `KIMI_AGENTS_MD`, `KIMI_SKILLS`, `KIMI_OS`, `KIMI_SHELL`
  (this file is injected via `KIMI_AGENTS_MD`).
- **Tooling**: `src/kimi_cli/soul/toolset.py` loads tools by import path, injects dependencies,
  and runs tool calls. Built-in tools live in `src/kimi_cli/tools/` (agent, shell, file, web,
  todo, background, dmail, think, plan). MCP tools are loaded via `fastmcp`; CLI management is
  in `src/kimi_cli/mcp.py` and stored in the share dir.
- **Subagents**: `LaborMarket` in `src/kimi_cli/soul/agent.py` registers builtin subagent types.
  The `Agent` tool (`src/kimi_cli/tools/agent/`) creates or resumes subagent instances, while
  `SubagentStore` persists instance metadata, prompts, wire logs, and context under
  `session/subagents/<agent_id>/`.
- **Core loop**: `src/kimi_cli/soul/kimisoul.py` is the main agent loop. It accepts user input,
  handles slash commands (`src/kimi_cli/soul/slash.py`), appends to `Context`
  (`src/kimi_cli/soul/context.py`), calls the LLM (kosong), runs tools, and performs compaction
  (`src/kimi_cli/soul/compaction.py`) when needed.
- **Approvals**: `src/kimi_cli/soul/approval.py` is the tool-facing facade. `ApprovalRuntime`
  in `src/kimi_cli/approval_runtime/` is the session-level source of truth for pending approvals,
  and approval requests are projected onto the root wire stream for Shell/Web style UIs.
- **UI/Wire**: `src/kimi_cli/soul/run_soul` connects `KimiSoul` to a `Wire`
  (`src/kimi_cli/wire/`) so UI loops can stream events. UIs live in `src/kimi_cli/ui/`
  (shell/print/acp/wire).
- **Shell UI**: `src/kimi_cli/ui/shell/` handles interactive TUI input, shell command mode,
  and slash command autocomplete; it is the default interactive experience.
- **Slash commands**: Soul-level commands live in `src/kimi_cli/soul/slash.py`; shell-level
  commands live in `src/kimi_cli/ui/shell/slash.py`. The shell UI exposes both and dispatches
  based on the registry. Standard skills register `/skill:<skill-name>` and load `SKILL.md`
  as a user prompt; flow skills register `/flow:<skill-name>` and execute the embedded flow.

## Major modules and interfaces

- `src/kimi_cli/app.py`: `KimiCLI.create(...)` and `KimiCLI.run(...)` are the main programmatic
  entrypoints; this is what UI layers use.
- `src/kimi_cli/soul/agent.py`: `Runtime` (config, session, builtins), `Agent` (system prompt +
  toolset), and `LaborMarket` (builtin subagent type registry).
- `src/kimi_cli/soul/kimisoul.py`: `KimiSoul.run(...)` is the loop boundary; it emits Wire
  messages and executes tools via `KimiToolset`.
- `src/kimi_cli/soul/context.py`: conversation history + checkpoints; used by DMail for
  checkpointed replies.
- `src/kimi_cli/soul/toolset.py`: load tools, run tool calls, bridge to MCP tools.
- `src/kimi_cli/ui/*`: shell/print/acp frontends; they consume `Wire` messages.
- `src/kimi_cli/wire/*`: event types and transport used between soul and UI.

## Repo map

- `src/kimi_cli/agents/`: built-in agent YAML specs and prompts
- `src/kimi_cli/prompts/`: shared prompt templates
- `src/kimi_cli/soul/`: core runtime/loop, context, compaction, approvals
- `src/kimi_cli/tools/`: built-in tools
- `src/kimi_cli/ui/`: UI frontends (shell/print/acp/wire)
- `src/kimi_cli/acp/`: ACP server components
- `src/kimi_cli/auth/`: OAuth, platform definitions, and API key resolution
- `src/kimi_cli/mcp.py`: MCP server management and configuration
- `packages/kosong/`, `packages/kaos/`: workspace deps
  + Kosong is an LLM abstraction layer designed for modern AI agent applications.
    It unifies message structures, asynchronous tool orchestration, and pluggable
    chat providers so you can build agents with ease and avoid vendor lock-in.
  + PyKAOS is a lightweight Python library providing an abstraction layer for agents
    to interact with operating systems. File operations and command executions via KAOS
    can be easily switched between local environment and remote systems over SSH.
- `tests/`, `tests_ai/`: test suites
- `klips`: Kimi Code CLI Improvement Proposals

## Conventions and quality

- Python >=3.12 (ty config uses 3.14); line length 100.
- Ruff handles lint + format (rules: E, F, UP, B, SIM, I); pyright + ty for type checks.
- Tests use pytest + pytest-asyncio; files are `tests/test_*.py`.
- CLI entry points: `kimi` / `kimi-cli` -> `src/kimi_cli/__main__.py` (routes to `src/kimi_cli/cli/__init__.py`).
- User config: `~/.kimi/config.toml`; logs, sessions, and MCP config live in `~/.kimi/`.
- OpenClaw config: `~/.openclaw/openclaw.json` (separate agent gateway bridge)
- Kimi Claw config: `~/.kimi/kimi-claw/kimi-claw-config.json` (WebSocket bridge to agent gateway)

## Git commit messages

Conventional Commits format:

```
<type>(<scope>): <subject>
```

Allowed types:
`feat`, `fix`, `test`, `refactor`, `chore`, `style`, `docs`, `perf`, `build`, `ci`, `revert`.

## Versioning

The project follows a **minor-bump-only** versioning scheme (`MAJOR.MINOR.PATCH`):

- **Patch** version is always `0`. Never bump it.
- **Minor** version is bumped for any change: new features, improvements, bug fixes, etc.
- **Major** version is only changed by explicit manual decision; it stays unchanged during
  normal development.

Examples: `0.68.0` → `0.69.0` → `0.70.0`; never `0.68.1`.

This rule applies to all packages in the repo (root, `packages/*`, `sdks/*`) as well as release
and skill workflows.

## Release workflow

1. Ensure `main` is up to date (pull latest).
2. Create a release branch, e.g. `bump-0.68` or `bump-pykaos-0.5.3`.
3. Update `CHANGELOG.md`: rename `[Unreleased]` to `[0.68] - YYYY-MM-DD`.
4. Update `pyproject.toml` version.
5. Run `uv sync` to align `uv.lock`.
6. Commit the branch and open a PR.
7. Merge the PR, then switch back to `main` and pull latest.
8. Tag and push:
   - `git tag 0.68` or `git tag pykaos-0.5.3`
   - `git push --tags`
9. GitHub Actions handles the release after tags are pushed.

## Agent behavior — flow control

When a `[Flow control]` system-reminder appears, **you MUST use the `flow_decision` tool** to
choose CONTINUE, STOP, or PAUSE. Do not reply with plain text. Do not reason your way around
the instruction. The tool is real, it works, and you have used it before.

**Hard rules:**
- If the system says "You MUST use the flow_decision tool," call it immediately.
- Never claim the tool does not exist, is a pseudo-tool, or is unavailable.
- Never substitute a text response when the system demands a flow_decision call.
- If you are confused about whether the tool exists, trust the system instruction and call it anyway.

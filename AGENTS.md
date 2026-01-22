# Kimi CLI

## Quick commands (use uv)

- `make prepare` (sync deps for all workspace packages and install git hooks)
- `make format`
- `make check`
- `make test`
- `make ai-test`
- `make build` / `make build-bin`

If running tools directly, use `uv run ...`.

## Project overview

Kimi CLI is a Python CLI agent for software engineering workflows. It supports an interactive
shell UI, ACP server mode for IDE integrations, and MCP tool loading.

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

- **CLI entry**: `src/kimi_cli/cli.py` (Typer) parses flags (UI mode, agent spec, config, MCP)
  and routes into `KimiCLI` in `src/kimi_cli/app.py`.
- **App/runtime setup**: `KimiCLI.create` loads config (`src/kimi_cli/config.py`), chooses a
  model/provider (`src/kimi_cli/llm.py`), builds a `Runtime` (`src/kimi_cli/soul/agent.py`),
  loads an agent spec, restores `Context`, then constructs `KimiSoul`.
- **Agent specs**: YAML under `src/kimi_cli/agents/` loaded by `src/kimi_cli/agentspec.py`.
  Specs can `extend` base agents, select tools by import path, and define fixed subagents.
  System prompts live alongside specs; builtin args include `KIMI_NOW`, `KIMI_WORK_DIR`,
  `KIMI_WORK_DIR_LS`, `KIMI_AGENTS_MD`, `KIMI_SKILLS` (this file is injected via
  `KIMI_AGENTS_MD`).
- **Tooling**: `src/kimi_cli/soul/toolset.py` loads tools by import path, injects dependencies,
  and runs tool calls. Built-in tools live in `src/kimi_cli/tools/` (shell, file, web, todo,
  multiagent, dmail, think). MCP tools are loaded via `fastmcp`; CLI management is in
  `src/kimi_cli/mcp.py` and stored in the share dir.
- **Subagents**: `LaborMarket` in `src/kimi_cli/soul/agent.py` manages fixed and dynamic
  subagents. The Task tool (`src/kimi_cli/tools/multiagent/`) spawns them.
- **Core loop**: `src/kimi_cli/soul/kimisoul.py` is the main agent loop. It accepts user input,
  handles slash commands (`src/kimi_cli/soul/slash.py`), appends to `Context`
  (`src/kimi_cli/soul/context.py`), calls the LLM (kosong), runs tools, and performs compaction
  (`src/kimi_cli/soul/compaction.py`) when needed.
- **Approvals**: `src/kimi_cli/soul/approval.py` mediates user approvals for tool actions; the
  soul forwards approval requests over `Wire` for UI handling.
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
  toolset), and `LaborMarket` (subagent registry).
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
- `packages/kosong/`, `packages/kaos/`: workspace deps
  + Kosong is an LLM abstraction layer designed for modern AI agent applications.
    It unifies message structures, asynchronous tool orchestration, and pluggable
    chat providers so you can build agents with ease and avoid vendor lock-in.
  + PyKAOS is a lightweight Python library providing an abstraction layer for agents
    to interact with operating systems. File operations and command executions via KAOS
    can be easily switched between local environment and remote systems over SSH.
- `tests/`, `tests_ai/`: test suites
- `klips`: Kimi CLI Improvement Proposals

## Conventions and quality

- Python >=3.12 (ty config uses 3.14); line length 100.
- Ruff handles lint + format (rules: E, F, UP, B, SIM, I); pyright + ty for type checks.
- Tests use pytest + pytest-asyncio; files are `tests/test_*.py`.
- CLI entry points: `kimi` / `kimi-cli` -> `src/kimi_cli/cli.py`.
- User config: `~/.kimi/config.toml`; logs, sessions, and MCP config live in `~/.kimi/`.

## Git commit messages

Conventional Commits format:

```
<type>(<scope>): <subject>
```

Allowed types:
`feat`, `fix`, `test`, `refactor`, `chore`, `style`, `docs`, `perf`, `build`, `ci`, `revert`.

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

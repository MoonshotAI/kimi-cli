# Kimi Code CLI

## Quick commands (use uv)

- `make prepare` (sync deps for all workspace packages and install git hooks)
- `make format`
- `make check`
- `make test`
- `make ai-test`
- `make build` / `make build-bin`

If running tools directly, use `uv run ...`.

## Running tests

- **Run all tests**: `make test` or `uv run pytest tests tests_e2e -vv`
- **Run single test file**: `uv run pytest tests/core/test_config.py -vv`
- **Run single test function**: `uv run pytest tests/core/test_config.py::test_default_config -vv`
- **Run tests matching pattern**: `uv run pytest -k "test_config" -vv`
- **Run specific test directory**: `uv run pytest tests/core -vv`

## Project overview

Kimi Code CLI is a Python CLI agent for software engineering workflows. It supports an interactive
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
- `tests/`, `tests_ai/`, `tests_e2e/`: test suites
- `klips`: Kimi Code CLI Improvement Proposals

## Code style guidelines

### General conventions
- **Line length**: 100 characters max
- **Python version**: 3.12+ (tooling configured for 3.14)
- **Indentation**: 4 spaces (standard Python)

### Imports
- Use `from __future__ import annotations` for all files (enables forward references)
- Sort imports with ruff (isort rules): stdlib → third-party → local
- Use type imports under `if TYPE_CHECKING:` block to avoid circular imports
- Example:
  ```python
  from __future__ import annotations

  import asyncio
  from collections.abc import Mapping
  from typing import TYPE_CHECKING

  import pydantic

  from kimi_cli.config import Config

  if TYPE_CHECKING:
      from fastmcp.mcp_config import MCPConfig
  ```

### Types
- Use Pydantic for data validation (`pydantic.BaseModel`, `pydantic.Field`)
- Use dataclasses for simple data containers (`@dataclass(slots=True, kw_only=True)`)
- Use `typing.TYPE_CHECKING` for import-only types
- Return types: `str | None` (not `Optional[str]`)

### Naming
- **Modules**: lowercase, snake_case (`soul/agent.py`)
- **Classes**: PascalCase (`Kimisoul`, `Runtime`)
- **Functions/variables**: snake_case (`load_agents_md`, `model_name`)
- **Constants**: UPPER_SNAKE_CASE
- **Private members**: prefix with underscore (`_internal_method`)

### Error handling
- Use custom exceptions from `src/kimi_cli/exception.py`
- Base class: `KimiCLIException(Exception)`
- Inherit from appropriate built-in: `ConfigError(KimiCLIException, ValueError)`
- Raise with descriptive messages: `raise ConfigError(f"Invalid model {name}")`

### Logging
- Use `loguru` via `from kimi_cli.utils.logging import logger`
- Log levels: `logger.trace()`, `logger.debug()`, `logger.info()`, `logger.warning()`,
  `logger.error()`, `logger.critical()`
- Include context in logs: `logger.info("Loaded agents.md: {path}", path=path)`

### Pydantic models
- Use `Field()` for validation with descriptions
- Use `@model_validator(mode="after")` for cross-field validation
- Use `model_dump()` for serialization
- Example:
  ```python
  class Config(BaseModel):
      default_model: str = Field(default="", description="Default model to use")
      models: dict[str, LLMModel] = Field(default_factory=dict)

      @model_validator(mode="after")
      def validate_model(self) -> Self:
          if self.default_model and self.default_model not in self.models:
              raise ValueError(f"Default model {self.default_model} not found in models")
          return self
  ```

### Async code
- Use `async`/`await` for I/O operations
- Prefer `asyncio` over `threading`
- Use `run_in_executor` for blocking code when needed

### Testing
- Test files in `tests/test_*.py` or `tests/*/test_*.py`
- Use `pytest` with `pytest-asyncio` for async tests
- Use `inline_snapshot` for assertions (auto-updates with `uv run pytest --sync`)
- Use fixtures from `tests/conftest.py`
- Example:
  ```python
  import pytest
  from inline_snapshot import snapshot

  def test_default_config():
      config = get_default_config()
      assert config == snapshot(Config(...))
  ```

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

# Kimi CLI Python Implementation

## Quick Overview

**Kimi CLI Python** is the original AI agent for terminal software engineering workflows. It implements the core agent loop, CLI routing, UI, tools, and LLM integration in Python.

- **Language**: Python 3.12+ (tooling configured for 3.14)
- **Runtime**: CPython, async via asyncio
- **Build**: uv + uv_build; PyInstaller for binaries
- **UI**: prompt-toolkit (shell TUI)
- **CLI**: Typer
- **LLM**: kosong (multi-provider abstraction)

## Tech Stack

### Core

| Component | Package | Role |
|-----------|---------|------|
| Runtime | Python 3.12+ | Async-first, type-annotated |
| CLI | Typer | CLI argument parsing & routing |
| Config | Pydantic | TOML config loading, schema validation |
| Async | asyncio | Async runtime for I/O-bound operations |

### LLM & Agent

| Component | Package | Role |
|-----------|---------|------|
| LLM abstraction | kosong | Unified chat provider, tool orchestration |
| OS abstraction | kaos (PyKAOS) | File ops, shell exec (local/remote) |
| MCP | fastmcp | MCP tool loading & management |

### UI & Terminal

| Component | Package | Role |
|-----------|---------|------|
| Shell TUI | prompt-toolkit | Interactive terminal input/output |
| Logging | loguru | Structured disk logging |

### Development

| Tool | Package | Role |
|------|---------|------|
| Linter/Formatter | ruff | Rules: E, F, UP, B, SIM, I |
| Type Checking | pyright, ty | Static type analysis |
| Testing | pytest + pytest-asyncio | Unit & integration tests |
| Package Manager | uv | Dependency management & builds |

## Directory Structure

```
src/kimi_cli/
├── Root files ........................ Entry, config, app, session, LLM
│   ├── __main__.py                    Package entry (routes to cli/)
│   ├── app.py                         KimiCLI factory (create + run)
│   ├── config.py                      TOML config loading + Pydantic validation
│   ├── llm.py                         Multi-provider LLM abstraction
│   ├── session.py                     Session management (per-workdir)
│   ├── session_fork.py                Session forking for subagents
│   ├── session_state.py               Session state persistence
│   ├── agentspec.py                   Agent spec YAML loading + inheritance
│   ├── constant.py                    NAME, VERSION, USER_AGENT
│   ├── exception.py                   Custom exception types
│   ├── metadata.py                    Work directory metadata
│   ├── share.py                       Share directory (~/.kimi/)
│   └── mcp.py                         MCP server config management
├── cli/ .............................. Typer CLI routing & commands
├── soul/ ............................. Core agent loop & runtime
├── tools/ ............................ Built-in tools (file, shell, web, etc.)
├── ui/ ............................... UI frontends (shell, print, acp)
├── wire/ ............................. Event streaming protocol
├── agents/ ........................... Agent YAML specs & prompts
├── prompts/ .......................... Shared prompt templates
├── acp/ .............................. ACP server components
├── subagents/ ........................ Sub-agent system
├── approval_runtime/ ................. Approval state management
├── auth/ ............................. OAuth & token management
├── background/ ....................... Background task manager
├── hooks/ ............................ Event hook system
├── notifications/ .................... User notifications
├── plugin/ ........................... Plugin management (MCP-based)
├── skill/ ............................ Skill loading, indexing, flows
├── deps/ ............................. Dependency injection
├── utils/ ............................ Utilities (logging, async, etc.)
├── vis/ .............................. Visualization helpers
└── web/ .............................. Web-related utilities
```

## Architecture Layers

### 1. Entry Point & CLI Routing

**File**: `__main__.py`, `cli/__init__.py`

```
__main__.py
  └─ cli/__init__.py (Typer dispatcher)
       ├─ shell mode  → Shell TUI (default)
       ├─ print mode  → Non-interactive print
       ├─ acp mode    → IDE integration server (ACP)
       └─ subcommands → model, login, config, mcp, plugin, export, import
```

CLI parses flags (UI mode, agent spec, config, MCP) and routes into `KimiCLI` in `app.py`.

### 2. App Factory & Runtime

**File**: `app.py`

`KimiCLI.create()` wires together all components:

1. Load config (`config.py`) — TOML + Pydantic validation
2. Load agent spec (`agentspec.py`) — YAML with Jinja2 system prompt
3. Choose LLM provider (`llm.py`) — via kosong ChatProvider
4. Create session (`session.py`) — per-workdir, persistent
5. Build Runtime (`soul/agent.py`) — config + session + builtins
6. Restore Context (`soul/context.py`) — conversation history
7. Return configured `KimiSoul` ready for `.run()`

### 3. Core Agent Loop

**File**: `soul/kimisoul.py`

The main event loop (`KimiSoul.run`):

1. Accept user input
2. Handle slash commands (`soul/slash.py`)
3. Append to conversation history (Context)
4. Call LLM with tools (kosong streaming)
5. Execute tool calls (with approvals via `soul/approval.py`)
6. Emit wire events (for UI)
7. Perform compaction when needed (`soul/compaction.py`)
8. Repeat

**Key Files**:
- `soul/kimisoul.py` — Main loop orchestrator
- `soul/agent.py` — `Runtime`, `Agent`, `LaborMarket` (subagent type registry)
- `soul/context.py` — Conversation history + checkpoints
- `soul/toolset.py` — Tool loading, execution, MCP bridge
- `soul/approval.py` — Tool approval facade
- `soul/compaction.py` — Auto-compaction when context exceeds token limits
- `soul/slash.py` — Soul-level slash command registry
- `soul/dynamic_injections/` — Dynamic system prompt injections (plan mode, yolo mode)

### 4. Tooling System

**File**: `soul/toolset.py`

Tools are loaded by import path and executed via `KimiToolset`. Built-in tools live in `tools/`:

| Tool | Directory | Purpose |
|------|-----------|---------|
| Agent | `tools/agent/` | Create/resume sub-agents |
| Shell | `tools/shell/` | Execute shell commands |
| File Read | `tools/file/` | Read file contents |
| File Write | `tools/file/` | Write files |
| File Edit | `tools/file/` | Find-replace in files |
| Glob | `tools/file/` | File pattern matching |
| Grep | `tools/file/` | Text search in files |
| Web Fetch | `tools/web/` | HTTP requests |
| Web Search | `tools/web/` | Web search |
| Ask User | `tools/ask_user/` | Get user input |
| Plan | `tools/plan/` | Planning & task breakdown |
| Think | `tools/think/` | Extended reasoning |
| Todo | `tools/todo/` | Todo list management |
| Background | `tools/background/` | Background task queue |
| DMail | `tools/dmail/` | Checkpointed agent messaging |

MCP tools are loaded via `fastmcp`; CLI management is in `mcp.py`.

### 5. User Interface

**File**: `ui/shell/`

prompt-toolkit-based interactive TUI:

- `ui/shell/` — Interactive shell with prompt, approval panels, slash commands
- `ui/print/` — Non-interactive print mode
- `ui/acp/` — ACP server mode for IDE integrations
- `ui/theme.py` — UI theming

Shell UI handles:
- Input with history and autocomplete
- Slash command dispatch (soul-level + shell-level)
- Approval panel rendering
- Streaming message display

### 6. Wire Protocol & Events

**File**: `wire/types.py`

Event streaming between soul and UI:

- `wire/types.py` — Wire message type definitions
- `wire/protocol.py` — Wire protocol
- `wire/server.py` — Wire server (stdio/websocket)
- `wire/file.py` — Wire message file persistence
- `wire/jsonrpc.py` — JSON-RPC transport
- `wire/root_hub.py` — Message hub for multi-agent routing
- `wire/serde.py` — Serialization/deserialization

### 7. Agent Specs

**Directory**: `agents/`

YAML-based agent definitions:

- `agents/default/agent.yaml` — Default agent (tools, system prompt, subagents)
- `agents/okabe/agent.yaml` — Alternative agent config
- Specs support inheritance via `extend` field
- System prompts are Jinja2 templates with builtin variables: `KIMI_NOW`, `KIMI_WORK_DIR`, `KIMI_WORK_DIR_LS`, `KIMI_AGENTS_MD`, `KIMI_SKILLS`, `KIMI_OS`, `KIMI_SHELL`

### 8. Sub-agents

**File**: `soul/agent.py` (LaborMarket), `tools/agent/` (Agent tool)

- `subagents/models.py` — `AgentTypeDefinition`, `ToolPolicy`
- `subagents/registry.py` — `LaborMarket`: agent type registration
- `subagents/builder.py` — Subagent instance builder
- `subagents/runner.py` — Subagent execution runner
- `subagents/store.py` — Instance state persistence under `session/subagents/<agent_id>/`

### 9. Skills

**Directory**: `skill/`

- `skill/` — Skill loading, indexing, discovery from `~/.kimi/skills/`, `.kimi/skills/`
- `skill/flow/` — Skill flow graph (choice-based skill routing)
- Standard skills register `/skill:<name>` and load `SKILL.md`
- Flow skills register `/flow:<name>` and execute embedded flow

## Key Patterns

### Async Throughout

```python
async def run(self, wire: Wire) -> None:
    async for event in self.soul.run(user_input):
        await wire.emit(event)
```

### Pydantic for Config & Models

```python
class KimiConfig(BaseModel):
    default_model: str | None = None
    providers: dict[str, ProviderConfig] = {}
```

### Dataclasses for Domain Objects

```python
@dataclass(slots=True)
class Agent:
    system_prompt: str
    toolset: KimiToolset
    runtime: Runtime
```

### kosong Framework

```python
# ChatProvider for LLM calls
provider = ChatProvider(model=model, api_key=key)
async for chunk in provider.stream(messages, tools):
    ...

# Tool definition
class MyTool(Tool):
    async def call(self, params: dict) -> str:
        ...
```

### kaos for OS Operations

```python
from kaos import KaosPath
path = KaosPath("/some/file")
content = await path.read_text()
```

### loguru for Logging

```python
from kimi_cli.utils.logging import logger

logger.debug("Detailed trace info")
logger.info("Normal operation")
logger.error("Something failed: {}", err)
```

**Never use `print()` or `sys.stderr` for debug output** — always use the disk logger.

## Slash Commands

- **Soul-level**: `soul/slash.py` — commands available in all UI modes
- **Shell-level**: `ui/shell/slash.py` — commands specific to the shell TUI
- Shell UI exposes both and dispatches based on the registry

## Configuration

### User Config (`~/.kimi/config.toml`)

Key fields: `default_model`, `default_thinking`, `default_yolo`, `default_plan_mode`, `theme`, `models`, `providers`, `loop_control`, `hooks`, `services`, `background`, `mcp`.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `KIMI_BASE_URL` | Override API base URL |
| `KIMI_API_KEY` | Override API key |
| `KIMI_MODEL_NAME` | Override model name |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | Override max context size |
| `KIMI_MODEL_CAPABILITIES` | Override model capabilities |
| `KIMI_MODEL_TEMPERATURE` | Override temperature |
| `KIMI_MODEL_TOP_P` | Override top_p |
| `KIMI_MODEL_MAX_TOKENS` | Override max tokens |
| `KIMI_SHARE_DIR` | Override share directory (default: `~/.kimi/`) |

## Running

```bash
# Interactive shell
uv run kimi

# Print mode
uv run kimi --print "prompt here"

# Specific agent
uv run kimi --agent okabe

# Tests
uv run pytest
uv run pytest tests/test_xxx.py

# Lint & format
make check    # ruff + pyright + ty
make format   # ruff format
make test     # pytest
```

## Conventions

- Python >=3.12; line length 100
- Ruff handles lint + format (rules: E, F, UP, B, SIM, I)
- pyright + ty for type checks
- Tests: `tests/test_*.py` with pytest + pytest-asyncio
- `@dataclass(slots=True)` for domain objects
- Pydantic models for config/validation
- Async patterns with `asyncio` and `AsyncGenerator`
- Python and TypeScript modules have 1:1 correspondence where applicable

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Kimi Code CLI** is an AI coding agent that runs in the terminal, helping with software development tasks and terminal operations. It reads/edits code, executes shell commands, searches web pages, and autonomously plans actions.

### Workspace Structure

This is a Python monorepo managed by `uv` with multiple workspace packages:

```
kimi-cli/
├── src/kimi_cli/          # Main CLI application
├── src/kimi_thermo/       # Thermodynamic regime management (custom addition)
├── packages/
│   ├── kosong/           # Workspace package
│   ├── kaos/             # Workspace package
│   └── kimi-code/        # Workspace package
├── sdks/kimi-sdk/        # Kimi SDK
├── web/                  # Web frontend (vite)
├── vis/                  # Visualization frontend (vite)
├── docs/                 # Documentation
└── examples/             # Usage examples
```

**Technology Stack:**
- **Language**: Python >=3.12 (configured for 3.14)
- **Package Manager**: `uv` (Python package installer and resolver)
- **Build System**: `uv_build`
- **CLI Framework**: typer
- **Web Framework**: FastAPI + uvicorn
- **Frontend**: Vite (for web and vis interfaces)
- **Testing**: pytest, pytest-asyncio
- **Linting**: ruff, pyright
- **Key Libraries**: prompt-toolkit, rich, MCP (Model Context Protocol), ACP (Agent Client Protocol)

## Common Commands

### Installation and Setup

```bash
# Install uv if not already installed
curl -LsSf https://code.kimi.com/install.sh | bash

# Sync all workspace dependencies (default target)
make prepare
# OR
uv sync --frozen --all-extras --all-packages

# Install git hooks (pre-commit)
make install-prek
```

### Running Kimi CLI

```bash
# Run from source (development)
uv run kimi

# Run specific scripts
uv run kimi-cli          # Same as kimi
uv run kimi-thermo       # Thermodynamic framework CLI

# Run with specific flags
kimi --continue          # Resume last session
kimi --session abc123    # Resume specific session
kimi -p "your query"     # Non-interactive mode
```

### Development Commands

```bash
# Format all code
make format
# OR format specific packages
make format-kimi-cli
make format-kosong

# Run tests
uv run pytest

# Type checking
uv run pyright

# Linting
uv run ruff check
uv run ruff format
```

### Web Development

```bash
# Start web backend (FastAPI, port 5494)
make web-back
# OR
uv run uvicorn kimi_cli.web.app:create_app --factory --reload --port 5494

# Start web frontend (Vite dev server)
make web-front
# OR
cd web && npm run dev

# Visualization interface (port 5495)
make vis-back    # Backend
make vis-front   # Frontend
```

### MCP (Model Context Protocol) Management

```bash
# Add HTTP MCP server
kimi mcp add --transport http context7 https://mcp.context7.com/mcp

# Add stdio MCP server
kimi mcp add --transport stdio chrome-devtools -- npx chrome-devtools-mcp@latest

# List MCP servers
kimi mcp list
```

## Environment Specifics

### Windows Requirements

- **Git Bash** or **WSL** recommended (Windows CMD has limitations)
- Use forward slashes in paths for cross-platform compatibility
- Virtual environment created at `.venv/`

### Python Version

- Minimum: Python 3.12
- Recommended: Python 3.14 (as configured in pyright)
- Use `uv` which automatically manages Python versions

### Package Installation

The project uses `uv` exclusively:

```bash
# Don't use pip or poetry
# Always use uv for this project
uv sync                  # Install dependencies
uv run <command>         # Run commands in venv
uv tool install <pkg>    # Install CLI tools
```

## GitHub Actions Workflows

Located in `.github/workflows/`:

- **CI**: `ci-kimi-cli.yml`, `ci-kosong.yml`, `ci-pykaos.yml`, `ci-kimi-sdk.yml`
- **Documentation**: `ci-docs.yml`, `docs-pages.yml`
- **Releases**: `release-kimi-cli.yml`, `release-kosong.yml`, etc.
- **Quality**: `pr-title-checker.yml`, `typos.yml`, `translator.yml`

## Git Configuration

- **Pre-commit hooks**: Managed by `prek` (install with `make install-prek`)
- **Conventional Commits**: PR titles checked by workflow
- **Python version**: Pinned in `.python-version` file

## Architecture Patterns

### CLI Entry Point

- **Main CLI**: `src/kimi_cli/cli.py` (typer application)
- **Scripts**: Defined in `pyproject.toml` under `[project.scripts]`
  - `kimi` and `kimi-cli` → `kimi_cli.cli:cli`
  - `kimi-thermo` → `kimi_thermo.main:main`

### Web Application

- **Backend**: FastAPI application factory in `src/kimi_cli/web/app.py`
- **Frontend**: Vite-based SPA in `web/` directory
- **API**: RESTful endpoints under `src/kimi_cli/web/api/`

### MCP Integration

- **FastMCP**: Used for MCP server implementations
- **Configuration**: Can be managed via `kimi mcp` commands
- **Transports**: Supports HTTP and stdio

### ACP Integration

- **Server Mode**: `kimi acp` starts ACP server
- **Compatible with**: Zed, JetBrains IDEs, VS Code (via extension)

## Key Files

### Configuration Files

- `pyproject.toml` - Main project configuration, dependencies, scripts
- `uv.lock` - Locked dependency versions
- `.python-version` - Python version for the project
- `.pre-commit-config.yaml` - Pre-commit hook configuration
- `pytest.ini` - pytest configuration

### Documentation

- `README.md` - Project overview and quick start
- `AGENTS.md` - Agent system documentation
- `CONTRIBUTING.md` - Contribution guidelines
- `CHANGELOG.md` - Version history
- `docs/` - Full documentation site (built with mkdocs)

### Development Tools

- `Makefile` - Common development tasks
- `kimi.spec` - PyInstaller spec for binary builds
- `scripts/` - Helper scripts
- `examples/` - Usage examples

## Thermodynamic Framework (Custom Addition)

Located in `src/kimi_thermo/`:

- **Purpose**: Thermodynamic regime management (T* framework) for Kimi CLI
- **Entry Point**: `kimi_thermo.main:main`
- **Components**:
  - `thermo_executor.py` - Core T* = (L - γ) / (|L| + λ) computation
  - `main.py` - CLI entry point
  - Additional implementation files

**Usage**:
```bash
uv run kimi-thermo "Your query" --audit
uv run kimi-thermo "AIME problem" --benchmark
```

**API Configuration**:
Set in `~/.kimi/config.json`:
```json
{
  "providers": {
    "moonshot-ai": {
      "type": "kimi",
      "base_url": "https://api.moonshot.ai/v1",
      "api_key": "sk-kimi-..."
    }
  }
}
```

## Common Workflows

### Adding a New Workspace Package

1. Create package directory under `packages/`
2. Add to `[tool.uv.workspace].members` in root `pyproject.toml`
3. Run `uv sync --all-packages`

### Running Tests

```bash
# All tests
uv run pytest

# Specific test file
uv run pytest tests/test_something.py

# With coverage
uv run pytest --cov=kimi_cli
```

### Creating a Release

GitHub Actions automatically handle releases via `release-*.yml` workflows when tags are pushed.

### Working with Sessions

```bash
kimi --continue              # Resume last session
kimi --session abc123        # Resume specific session ID
kimi                         # Start new session
/sessions                    # Browse sessions (in CLI)
/clear                       # Clear context (in CLI)
/compact                     # Compress context (in CLI)
```

## IDE Integration

### VS Code Extension

Install: [Kimi Code VS Code Extension](https://marketplace.visualstudio.com/items?itemName=moonshot-ai.kimi-code)

### ACP-Compatible Editors

Configure in editor settings:
```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "command": "kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Supported: Zed, JetBrains IDEs

### Zsh Integration

Install [zsh-kimi-cli](https://github.com/MoonshotAI/zsh-kimi-cli) plugin for Ctrl-X agent mode switching.

## Documentation

- **Online**: https://moonshotai.github.io/kimi-cli/en/
- **Local Build**: `make docs` (if configured)
- **Chinese**: https://moonshotai.github.io/kimi-cli/zh/

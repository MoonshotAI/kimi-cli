# Kimi CLI - AI Coding Agent

## Project Overview

Kimi CLI is an interactive command-line interface agent specializing in software engineering tasks. It's built with Python and provides a modular architecture for AI-powered development assistance. The project uses a sophisticated agent system with customizable tools, multiple UI modes, and extensive configuration options.

## Technology Stack

- **Language**: Python 3.13+
- **Package Management**: uv (modern Python package manager)
- **Build System**: uv_build
- **CLI Framework**: Typer
- **LLM Integration**: kosong (custom LLM framework)
- **Async Runtime**: asyncio
- **Testing**: pytest with asyncio support
- **Code Quality**: ruff (linting/formatting), pyright (type checking)
- **Distribution**: PyInstaller for standalone executables

## Architecture

### Core Components

1. **Agent System** (`src/kimi_cli/agent.py`)
   - YAML-based agent specifications
   - System prompt templating with builtin arguments
   - Tool loading and dependency injection
   - Subagent support for task delegation

2. **Soul Architecture** (`src/kimi_cli/soul/`)
   - `KimiSoul`: Main agent execution engine
   - `Context`: Session history management
   - `DenwaRenji`: Communication hub for tools
   - Event-driven architecture with retry mechanisms

3. **UI Modes** (`src/kimi_cli/ui/`)
   - **Shell**: Interactive terminal interface (default)
   - **Print**: Non-interactive mode for scripting
   - **ACP**: Agent Client Protocol server mode

4. **Tool System** (`src/kimi_cli/tools/`)
   - Modular tool architecture with dependency injection
   - Built-in tools: bash, file operations, web search, task management
   - MCP (Model Context Protocol) integration for external tools
   - Custom tool development support

### Key Directories

```
src/kimi_cli/
├── agents/           # Default agent configurations
├── soul/            # Core agent execution logic
├── tools/           # Tool implementations
│   ├── bash/       # Shell command execution
│   ├── file/       # File operations (read, write, grep, etc.)
│   ├── web/        # Web search and URL fetching
│   ├── task/       # Subagent task delegation
│   └── dmail/      # Time-travel messaging system
└── ui/              # User interface implementations
```

## Build and Development

### Installation

```bash
# Install with uv
uv sync

# Install development dependencies
uv sync --group dev
```

### Build Commands

```bash
# Format code
make format
# or: uv run ruff check --fix && uv run ruff format

# Run linting and type checking
make check
# or: uv run ruff check && uv run ruff format --check && uv run pyright

# Run tests
make test
# or: uv run pytest tests -vv

# Build standalone executable
uv run pyinstaller kimi.spec
```

### Configuration

Configuration file: `~/.kimi/config.json`

Default configuration includes:

- LLM provider settings (Kimi API by default)
- Model configurations with context size limits
- Loop control parameters (max steps, retries)
- Service configurations (Moonshot Search API)

## Testing Strategy

- **Unit Tests**: Comprehensive test coverage for all tools and core components
- **Integration Tests**: End-to-end testing of agent workflows
- **Mock Providers**: LLM interactions mocked for consistent testing
- **Fixtures**: Extensive pytest fixtures for agent components and tools
- **Async Testing**: Full async/await testing support

Test files follow the pattern `test_*.py` and are organized by component:

- `test_load_agent.py`: Agent loading and configuration
- `test_bash.py`: Shell command execution
- `test_*_file.py`: File operation tools
- `test_task_subagents.py`: Subagent functionality

## Code Style Guidelines

- **Line Length**: 100 characters maximum
- **Formatter**: ruff with specific rule selection
- **Type Hints**: Enforced by pyright
- **Import Organization**: isort rules applied
- **Error Handling**: Specific exception types with proper chaining
- **Logging**: Structured logging with loguru

Selected ruff rules:

- E: pycodestyle
- F: Pyflakes
- UP: pyupgrade
- B: flake8-bugbear
- SIM: flake8-simplify
- I: isort

## Development Workflow

### Git Commit Message Style

This project follows the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification. Commit messages should follow this format:

```
<type>(<scope>): <subject>
```

**Allowed types:**
- `feat`: New features
- `fix`: Bug fixes
- `test`: Adding or updating tests
- `refactor`: Code refactoring without behavior changes
- `chore`: Maintenance tasks, dependency updates
- `style`: Code style changes (formatting, semicolons, etc.)
- `docs`: Documentation updates
- `perf`: Performance improvements
- `build`: Build system changes
- `ci`: CI/CD configuration changes
- `revert`: Reverting previous commits

**Examples:**
```
feat(agent): add new tool for file operations
fix(soul): resolve context memory leak issue
test(tools): add unit tests for grep functionality
docs: update installation instructions
```

### Quality Checks

Before submitting changes, always run these quality checks:

```bash
# Format code (runs ruff check --fix and ruff format)
make format

# Run linting and type checking (ruff check, ruff format --check, pyright)
make check

# Run all tests
make test

# Run specific test file
uv run pytest tests/test_bash.py -vv

# Run with coverage
uv run pytest tests --cov=src/kimi_cli
```

### Test Files Location

Test files are located in the `tests/` directory at the project root and follow these conventions:

- Named `test_*.py` (e.g., `test_bash.py`, `test_load_agent.py`)
- Mirror the source structure when appropriate
- Use pytest fixtures and async support for testing
- Comprehensive coverage for all tools and core components

Key test files include:
- `test_load_agent.py`: Agent loading and configuration
- `test_bash.py`: Shell command execution
- `test_*_file.py`: File operation tools (e.g., `test_read_file.py`)
- `test_task_subagents.py`: Subagent functionality
- `test_web_search.py`: Web search and URL fetching

### Running Scripts and Tools

Always use `uv run` to execute scripts and tools to ensure correct dependency management:

```bash
# Running Python scripts
uv run python script.py

# Running development tools
uv run pyright
uv run ruff check
uv run pytest

# Building the project
uv run pyinstaller kimi.spec

# Installing dependencies
uv sync                     # Install all dependencies
uv sync --group dev         # Install with development dependencies
```

This ensures that all dependencies are properly managed and isolated within the project environment.

## Security Considerations

- **File System Access**: Restricted to working directory by default
- **API Keys**: Handled as SecretStr with proper serialization
- **Shell Commands**: Executed with caution, user awareness emphasized
- **Network Requests**: Web tools with configurable endpoints
- **Session Management**: Persistent sessions with history tracking

## Agent Development

### Custom Agent Creation

1. Create agent specification file (YAML format)
2. Define system prompt with template variables
3. Select and configure tools
4. Optionally extend existing agents

### Available Tools

- **Shell**: Execute shell commands
- **ReadFile**: Read file contents with line limits
- **WriteFile**: Write content to files
- **Glob**: File pattern matching
- **Grep**: Content searching with regex
- **StrReplaceFile**: String replacement in files
- **PatchFile**: Apply patches to files
- **SearchWeb**: Web search functionality
- **FetchURL**: Download web content
- **Task**: Delegate to subagents
- **SendDMail**: Time-travel messaging
- **Think**: Internal reasoning tool
- **SetTodoList**: Task management

### System Prompt Arguments

Builtin variables available in system prompts:

- `${KIMI_NOW}`: Current timestamp
- `${KIMI_WORK_DIR}`: Working directory path
- `${KIMI_WORK_DIR_LS}`: Directory listing output
- `${KIMI_AGENTS_MD}`: Project AGENTS.md content

## Deployment

- **PyPI Package**: Distributed as `kimi-cli`
- **Standalone Binary**: Built with PyInstaller
- **Entry Point**: `kimi` command-line tool
- **Configuration**: User-specific config in `~/.kimi/`

## Version History

This project follows semantic versioning. For detailed version history, release notes, and changes across all versions, please refer to `CHANGELOG.md` in the project root.

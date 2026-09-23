# UI Layer Architecture (Python)

## Overview

The Python UI layer provides multiple frontends for interacting with KimiCLI:

- **Shell UI** (`shell/`) — Interactive TUI using prompt_toolkit (primary user-facing interface)
- **Print UI** (`print/`) — Non-interactive output mode for scripting/CI
- **ACP UI** (`acp/`) — Deprecated ACP server integration (now routes to separate `kimi acp` command)
- **Wire Protocol** (`wire/`) — Event transport layer between soul and UI
- **Theme System** (`theme.py`) — Centralized theme management for dark/light modes

## Directory Structure

```
src/kimi_cli/ui/
├── shell/              (14 files) ............ Interactive TUI (prompt_toolkit)
│   ├── __init__.py     (1,119 lines)  ....... Main Shell class & event loop
│   ├── prompt.py       (2,160 lines)  ....... Interactive prompt with completions
│   ├── visualize.py    (1,497 lines)  ....... Event rendering to TUI
│   ├── slash.py        (829 lines)    ....... Slash command registry & dispatch
│   ├── question_panel.py (586 lines)  ....... Multi-choice prompt UI
│   ├── approval_panel.py (481 lines)  ....... Tool approval request UI
│   ├── task_browser.py (486 lines)    ....... Task list browser TUI
│   ├── placeholders.py (531 lines)    ....... Prompt placeholder substitution
│   ├── keyboard.py     (300 lines)    ....... Keyboard input event handling
│   ├── usage.py        (281 lines)    ....... Usage stats display
│   ├── update.py       (217 lines)    ....... Update checking
│   ├── setup.py        (212 lines)    ....... Initial setup/onboarding
│   ├── replay.py       (210 lines)    ....... Session replay functionality
│   ├── debug.py        (190 lines)    ....... Debug utilities
│   ├── console.py      (3.5 KB)       ....... Rich console wrapper
│   ├── echo.py         (556 bytes)    ....... User input echo rendering
│   ├── mcp_status.py   (3.7 KB)       ....... MCP connection status display
│   ├── oauth.py        (4.7 KB)       ....... OAuth/authentication UI
│   └── startup.py      (890 bytes)    ....... Startup screen
├── print/              (2 files) ............ Non-interactive output mode
│   ├── __init__.py     (80-95 lines)  ....... Print UI class
│   └── visualize.py    (100+ lines)   ....... Event visualization
├── acp/                (1 file) ............ ACP server (deprecated)
│   └── __init__.py     (81 lines)     ....... Routes to separate `kimi acp` command
├── theme.py            (239 lines)    ....... Centralized theme definitions
└── __init__.py         (minimal)      ....... Module exports
```

**Related module** (separate directory):
```
src/kimi_cli/wire/      (9 files) ............ Event streaming protocol
```

## Architecture Overview

### Overall Flow

```
User Input
    ↓
Shell.prompt() / Prompt input handling
    ↓
KimiSoul.run() (core loop)
    ↓
Wire.send() (soul-side event stream)
    ↓
UI Visualization (shell/print)
    ↓
Console Output (Rich rendering)
```

### Wire Event System

The **Wire** class is an **SPMC (Single Producer, Multiple Consumer)** async channel:
- **Soul-side**: `WireSoulSide.send(event)` publishes events
- **UI-side**: `WireUISide.receive()` async iterator consumes events
- **Optional**: File-based recording for session replay
- **Merging**: Adjacent events of same type are merged to reduce noise

**Wire Message Types** (`wire/types.py`):
```python
WireMessage = Union[
    TurnBegin, TurnEnd,
    StepBegin, StepInterrupted,
    ContentPart,  # text/image/audio content
    ToolCall, ToolCallPart, ToolResult,
    ApprovalRequest, ApprovalResponse,
    QuestionRequest,
    StatusUpdate,
    Notification,
    CompactionBegin, CompactionEnd,
    # Custom display blocks:
    DiffDisplayBlock, ShellDisplayBlock, TodoDisplayBlock, BackgroundTaskDisplayBlock
]
```

## Shell UI (`shell/`)

### Architecture

**Three-tier design:**

1. **Input Layer** (`prompt.py`)
   - `CustomPromptSession` — Extended `PromptSession` with slash command completions
   - `UserInput` — Dataclass holding user input + metadata
   - `PromptMode` — Enum: DEFAULT, PLAN, SHELL
   - Supports multiple prompt modes with placeholders
   - History management with multiline support
   - Keyboard bindings (Ctrl+R replay, Ctrl+X debug)

2. **Event Processing Layer** (`visualize.py`)
   - `visualize()` — Main async consumer of Wire events
   - Renders each event type to Rich console
   - Handles live output with Rich `Live` display
   - Real-time keyboard listener integration
   - Supports complex UIs: task browser, approval panels, questions

3. **Output Layer** (`console.py`, `echo.py`, etc.)
   - `_KimiConsole` — Rich Console subclass with custom pager
   - Theme-aware styling via `theme.py`
   - Markdown, diff, table, and panel rendering

### Shell UI Main Loop (`__init__.py`)

**Key Classes:**
- `Shell` — Main TUI orchestrator
- `_BackgroundCompletionWatcher` — Auto-triggers on bg task completion
- `_PromptEvent` — Internal event type union

**Event Loop Flow:**
```
1. Print welcome + load context
2. Start background watchers (update check, completion)
3. Loop:
   a. Display prompt (via prompt.py)
   b. Accept user input
   c. Create WireUISide listener + create KimiSoul
   d. Run soul.run() with Wire connection
   e. Consume Wire events via visualize()
   f. Handle SIGINT gracefully
   g. Save session state
```

**Key Methods:**
- `run()` — Main async event loop
- `_handle_wire_events()` — Manages Wire subscription + visualization
- `_show_notification()` — Toast display for background task completions

### Prompt System (`prompt.py`)

**Features:**
- Slash command completion with filtering
- Shell command mode (leading `!`)
- Multiline input support
- History management (persisted per session)
- Custom key bindings
- Bottom toolbar with dynamic status indicators:
  - Yolo mode indicator
  - Plan mode indicator
  - Current working directory
  - Background tasks count
- Placeholder substitution:
  - `{cwd}` → current working directory
  - `{shell_mode_indicator}` → shell mode status
  - `{tips}` → contextual tips

**Completers:**
- `SlashCommandCompleter` — `/` commands
- `ShellCommandCompleter` — Shell commands (via `zsh` compctl)
- `FilePathCompleter` — File paths
- `MentionCompleter` — `@` mentions for file patterns

### Event Visualization (`visualize.py`)

**Main Function:** `visualize(wire_ui_side, ...)`

**Renders:**
- `TurnBegin/End` — Turn markers
- `StepBegin/StepInterrupted` — Step lifecycle with spinner
- `ContentPart` — Text, images, audio links (streaming support)
- `ToolCall` — Tool invocation info (name, input, status)
- `ToolResult` — Tool output with Rich formatting (diff, shell, todo, etc.)
- `ApprovalRequest` — Interactive approval panels
- `QuestionRequest` — Multi-choice question panels
- `Notification` — Background task notifications
- `CompactionBegin/End` — Context compression markers
- `StatusUpdate` — Agent status changes
- `BackgroundTaskDisplayBlock` — Running task visualization

**Features:**
- Live streaming content with cursor updates
- Real-time keyboard listener for interruption (Esc key)
- Complex panel layouts for approvals and questions
- Task browser TUI integration
- Diff highlighting (added/removed lines)
- Shell output syntax highlighting
- Todo list formatting

### Slash Command System (`slash.py`)

**Two-level dispatch:**
- **Soul-level**: Commands in `src/kimi_cli/soul/slash.py` (e.g., `/think`)
- **Shell-level**: Commands in `src/kimi_cli/ui/shell/slash.py` (e.g., `/task`)

**Shell Command Registry:**
```python
registry = {
    "/debug": CommandInfo(...),      # Toggle debug output
    "/task": CommandInfo(...),       # Task browser
    "/export": CommandInfo(...),     # Export session
    "/import": CommandInfo(...),     # Import session
    "/replay": CommandInfo(...),     # Session replay
    "/skill:<name>": CommandInfo(...), # Load skill
    "/flow:<name>": CommandInfo(...),  # Execute flow
    "/update": CommandInfo(...),     # Check for updates
    "/usage": CommandInfo(...),      # Show usage stats
    "/oauth": CommandInfo(...),      # OAuth authentication
    # ... and more
}
```

**Skill Integration:**
- Standard skills register `/skill:<name>` and load `SKILL.md` as user prompt
- Flow skills register `/flow:<name>` and execute embedded flow
- Skill discovery from `~/.kimi/skills/`, `.kimi/skills/`, `.claude/skills/`

### Approval & Question Panels

**ApprovalPanel** (`approval_panel.py`):
- Displays tool call requiring approval
- Shows tool name, input, brief description
- Approve/reject/modify options
- Keyboard navigation (↑↓ arrows)
- Rich formatting with colors

**QuestionPanel** (`question_panel.py`):
- Multi-choice question display
- Custom input for text questions
- Keyboard selection (↑↓ for choice, type for text)
- Integrates with Wire `QuestionRequest` events

### Task Browser (`task_browser.py`)

**Features:**
- TUI task list with live updates
- Filter and search tasks
- Keyboard navigation (↑↓ select, Enter view, D delete)
- Real-time task status display
- Color-coded by status (pending, in_progress, completed)

### Theme System (`theme.py`)

**Centralized theme management:**
```python
Theme definitions → Active theme state → Component resolvers
```

**Functions:**
- `get_diff_colors()` — Added/deleted line colors
- `get_task_browser_style()` — Task list styling
- `get_prompt_style()` — Prompt completion menu colors
- `get_toolbar_colors()` — Bottom toolbar colors
- `get_mcp_prompt_colors()` — MCP status colors
- `set_active_theme(theme)` — Global theme switch
- `get_active_theme()` → `Theme` — Current theme

**Themes:**
- Dark mode
- Light mode
- Auto (detects terminal background)

### Other Shell Components

**Keyboard Handling** (`keyboard.py`):
- `KeyboardEventListener` — Async keyboard event capture
- Used during event visualization for Esc (interrupt) key handling
- Integrates with prompt_toolkit event loop

**Placeholders** (`placeholders.py`):
- `PromptPlaceholder` — Substitution in prompt text
- Supports `{cwd}`, `{shell_mode_indicator}`, `{tips}`, etc.
- Dynamic tooltip rendering

**Console** (`console.py`):
- `_KimiConsole` — Rich Console subclass
- Custom pager handling
- Theme integration

**Usage Stats** (`usage.py`):
- `/usage` command implementation
- Token usage display
- Cost calculation (if applicable)

**Update Checking** (`update.py`):
- `/update` command
- Background version check
- Upgrade prompt

**Session Replay** (`replay.py`):
- `/replay` command
- Recent session history browser
- Replay and resume previous conversations

**OAuth** (`oauth.py`):
- `/oauth` command
- Platform OAuth flow
- Token management UI

**Setup/Onboarding** (`setup.py`):
- Initial configuration wizard
- API key input
- Model selection

## Print UI (`print/`)

### Architecture

**Two-tier design:**
- `Print` — Main class managing async loop
- Wire subscription (same as Shell)
- Implements `Printer` protocol

**Printer Protocol:**
```python
class Printer(Protocol):
    def feed(self, event: WireMessage) -> None: ...
    def flush(self) -> str: ...
```

**Implementations:**
1. `TextPrinter` — Human-readable text output
2. `JsonPrinter` — JSON-serialized messages (for scripting)

### Key Methods

- `run(soul)` — Main async loop
- `_consume_events()` — Wire event listener
- Outputs to stdout (can be piped)

### Use Cases

- CI/CD pipelines (JSON output)
- Batch processing (text output)
- Headless execution
- Logging to file

## ACP UI (`acp/`)

**Status:** Deprecated

The ACP (Agent Client Protocol) server integration has been moved to a separate `kimi acp` command. This directory now contains a minimal stub that routes to the external command.

## Key Patterns

### 1. Async Throughout

All UI operations are fully async using `asyncio`:
```python
async def run(self):
    async with self.wire.ui_side() as wire_ui:
        async for event in wire_ui.receive():
            # Process event
```

### 2. Wire Event Streaming

Loose coupling between soul (producer) and UI (consumer):
```python
# Soul-side
await wire.send(event)

# UI-side
async for event in wire_ui_side.receive():
    visualize(event)
```

### 3. Protocol Classes

Using protocols for extensibility:
```python
class Printer(Protocol):
    def feed(self, event): ...
    def flush(self) -> str: ...
```

### 4. Rich Integration

Terminal output via Rich library:
```python
from rich.console import Console
from rich.live import Live

console = Console()
with Live(renderable) as live:
    live.update(new_renderable)
```

### 5. Dataclasses

Configuration holding:
```python
@dataclass(slots=True)
class UserInput:
    text: str
    mode: PromptMode
    metadata: dict[str, Any]
```

## Important Conventions

### Shell UI Development

1. **Use Wire events, not direct calls**: Always consume events via `wire_ui_side.receive()`
2. **Keep rendering async**: Use async generators and Rich's `Live` for streaming content
3. **Handle SIGINT gracefully**: Always install SIGINT handler and cleanup
4. **Persist session state**: Call `session.save()` before exit
5. **Log with loguru**: Use `from kimi_cli.utils.logging import logger`
6. **Theme-aware colors**: Never hardcode colors; use `theme.py` functions

### Command Line Output

**Print mode conventions** (inherited from CLI entry):
- `stdout` — LLM responses + structured output
- `stderr` — User-visible diagnostics, errors, notifications
- No mixing of wire events and text output in print mode

### Tool Approval Integration

Approval requests are projected onto the Wire via `ApprovalRuntime`. The UI receives `ApprovalRequest` events and must respond via `wire.send(ApprovalResponse(...))`.

### File Locations

**Configs:**
- User config: `~/.kimi/config.toml`
- Logs: `~/.kimi/sessions/{SESSION_ID}/logs/`
- Sessions: `~/.kimi/sessions/{SESSION_ID}/`

**Skills:**
- User skills: `~/.kimi/skills/`, `.kimi/skills/`, `.claude/skills/`
- Built-in: `src/kimi_cli/skills/`

## Common Tasks

### Add a New Slash Command

1. Create command handler in `src/kimi_cli/ui/shell/slash.py`:
```python
@command("/mycommand")
async def handle_mycommand(args: str, context: ...) -> str:
    # Do work
    return "feedback message"
```

2. Register in `registry` dict with metadata:
```python
registry["/mycommand"] = CommandInfo(
    description="Does something",
    handler=handle_mycommand
)
```

### Add a New Wire Event Type

1. Define in `src/kimi_cli/wire/types.py`:
```python
@dataclass
class MyEvent:
    type: Literal["my_event"]
    data: str
```

2. Add handler in `src/kimi_cli/ui/shell/visualize.py`:
```python
elif isinstance(event, MyEvent):
    console.print(f"[bold]{event.data}[/bold]")
```

### Customize Theme

1. Edit `src/kimi_cli/ui/theme.py`
2. Add color definitions:
```python
@dataclass
class Theme:
    added_line = "#00ff00"
    deleted_line = "#ff0000"
    # ...
```

3. Register getter function:
```python
def get_my_colors() -> dict[str, str]:
    theme = get_active_theme()
    return {
        "added": theme.added_line,
        "deleted": theme.deleted_line,
    }
```

## Debugging

### Check Wire Events

Enable debug logging:
```bash
KIMI_LOG_LEVEL=debug uv run kimi
```

Logs written to `~/.kimi/sessions/{SESSION_ID}/logs/` (loguru).

### Test Shell UI Locally

```bash
# Shell mode (interactive TUI)
uv run kimi --ui shell

# Print mode (non-interactive)
uv run kimi --ui print

# With custom agent
uv run kimi --agent okabe
```

### Replay a Session

```bash
kimi /replay
```

Selects from recent session history and resumes.

### Debug Event Visualization

Add print statements in `visualize.py`:
```python
logger.debug(f"Event: {event}")
```

View logs:
```bash
tail -f ~/.kimi/sessions/{SESSION_ID}/logs/
```

## References

- **Python Architecture**: `AGENTS.md` (root, section "Architecture overview")
- **Wire Protocol**: `src/kimi_cli/wire/` module docs
- **Soul Loop**: `src/kimi_cli/soul/kimisoul.py` + `src/kimi_cli/soul/agent.py`
- **Config System**: `src/kimi_cli/config.py`
- **Session Management**: `src/kimi_cli/session.py`
- **Tools System**: `src/kimi_cli/tools/` directory

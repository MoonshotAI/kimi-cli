# Keyboard Shortcuts

Kimi Code CLI shell mode supports the following keyboard shortcuts.

## Shortcuts list

| Shortcut | Function |
|----------|----------|
| `Ctrl-X` | Toggle agent/shell mode |
| `Ctrl-J` | Insert newline |
| `Alt-Enter` | Insert newline (same as `Ctrl-J`) |
| `Ctrl-V` | Paste (supports images) |
| `Ctrl-E` | Expand full approval request content |
| `1`–`3` | Quick select approval option |
| `1`–`5` | Select question option by number |
| `Ctrl-D` | Exit Kimi Code CLI |
| `Ctrl-C` | Interrupt current operation |

## Mode switching

### `Ctrl-X`: Toggle agent/shell mode

Press `Ctrl-X` in the input box to switch between two modes:

- **Agent mode**: Input is sent to AI agent for processing
- **Shell mode**: Input is executed as local shell command

The prompt changes based on current mode:
- Agent mode: `✨` (normal) or `💫` (thinking mode)
- Shell mode: `$`

## Multi-line input

### `Ctrl-J` / `Alt-Enter`: Insert newline

By default, pressing `Enter` submits the input. To enter multi-line content, use:

- `Ctrl-J`: Insert newline at any position
- `Alt-Enter`: Insert newline at any position

Useful for entering multi-line code snippets or formatted text.

## Clipboard operations

### `Ctrl-V`: Paste

Paste clipboard content into the input box. Supports:

- **Text**: Pasted directly
- **Images**: Converted to base64 embedding (requires model image input support)

When pasting images, a placeholder `[image:xxx.png,WxH]` is displayed. The actual image data is sent along with the message to the model.

::: tip
Image pasting requires the model to support `image_in` capability.
:::

## Approval request operations

### `Ctrl-E`: Expand full content

When approval request preview content is truncated, press `Ctrl-E` to view the full content in a fullscreen pager. When preview is truncated, a "... (truncated, ctrl-e to expand)" hint is displayed.

Useful for viewing longer shell commands or file diff content.

### Number key quick selection

In the approval panel, press `1`–`3` to directly select and submit the corresponding approval option without navigating with arrow keys first.

## Structured question operations

When the AI uses the `AskUserQuestion` tool to ask you a question, the question panel supports the following keyboard operations:

| Shortcut | Function |
|----------|----------|
| `↑` / `↓` | Navigate options |
| `←` / `→` / `Tab` | Switch between questions (multi-question mode) |
| `1`–`5` | Select option by number (auto-submits for single-select, toggles for multi-select) |
| `Space` | Submit selection in single-select mode, toggle selection in multi-select mode |
| `Enter` | Confirm selection |
| `Esc` | Skip question |

When the AI asks multiple questions at once, the question panel displays them as tabs. Use `←` / `→` or `Tab` to switch between questions. Answered questions are marked as complete, and switching back to a previously answered question restores your earlier selection.

## Exit and interrupt

### `Ctrl-D`: Exit

Press `Ctrl-D` when the input box is empty to exit Kimi Code CLI.

### `Ctrl-C`: Interrupt

- In input box: Clear current input
- During agent execution: Interrupt current operation
- During slash command execution: Interrupt command

## Completion operations

In agent mode, a completion menu is automatically displayed while typing:

| Trigger | Completion content |
|---------|-------------------|
| `/` | Slash commands |
| `@` | File paths in working directory |

Completion operations:
- Arrow keys to select
- `Enter` to confirm selection
- `Esc` to close menu
- Continue typing to filter options

## Status bar

The bottom status bar displays:

- Current time
- Current mode (agent/shell) and model name (in agent mode)
- YOLO badge (when enabled)
- Shortcut hints
- Context usage

The status bar automatically refreshes to update information.

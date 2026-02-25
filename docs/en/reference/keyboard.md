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

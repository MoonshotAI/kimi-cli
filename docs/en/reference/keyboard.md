# Keyboard shortcuts

Kimi Code CLI shell mode supports the following keyboard shortcuts.

## Shortcut list

| Shortcut | Function |
|----------|----------|
| `Ctrl-X` | Toggle agent/shell mode |
| `Ctrl-/` | Show help |
| `Ctrl-J` | Insert new line |
| `Alt-Enter` | Insert new line (same as `Ctrl-J`) |
| `Ctrl-V` | Paste (supports images) |
| `Ctrl-E` | Expand approval request full content |
| `Ctrl-D` | Exit Kimi Code CLI |
| `Ctrl-C` | Interrupt current operation |

## Mode switching

### `Ctrl-X`: Toggle agent/shell mode

Press `Ctrl-X` in the input box to switch between two modes:

- **Agent mode**: Input is sent to the AI agent for processing
- **Shell mode**: Input is executed as a local shell command

The prompt changes based on the current mode:
- Agent mode: `✨` (normal) or `💫` (Thinking mode)
- Shell mode: `$`

### `Ctrl-/`: Show help

Press `Ctrl-/` in the input box to quickly display help information, equivalent to entering the `/help` slash command.

## Multi-line input

### `Ctrl-J` / `Alt-Enter`: Insert new line

By default, pressing `Enter` submits the input. To enter multi-line content, use:

- `Ctrl-J`: Insert a new line at any position
- `Alt-Enter`: Insert a new line at any position

Suitable for entering multi-line code snippets or formatted text.

## Clipboard operations

### `Ctrl-V`: Paste

Paste clipboard content into the input box. Supports:

- **Text**: Paste directly
- **Images**: Convert to base64 embedding (requires model support for image input)

When pasting an image, a placeholder `[image:xxx.png,WxH]` is displayed. The actual image data is passed to the model when sending.

::: tip Tip
Image pasting requires the model to support the `image_in` capability.
:::

## Approval request operations

### `Ctrl-E`: Expand full content

When the approval request preview content is truncated, press `Ctrl-E` to view the full content in a full-screen pager. When truncated, the preview displays the "... (truncated, ctrl-e to expand)" hint.

Suitable for viewing long shell commands or file diff content.

## Exit and interrupt

### `Ctrl-D`: Exit

Press `Ctrl-D` when the input box is empty to exit Kimi Code CLI.

### `Ctrl-C`: Interrupt

- In input box: Clear current input
- During agent runtime: Interrupt current operation
- During slash command execution: Interrupt command

## Completion operations

In agent mode, the completion menu is automatically displayed when typing:

| Trigger | Completion content |
|---------|-------------------|
| `/` | Slash commands |
| `@` | Working directory file paths |

Completion operations:
- Use arrow keys to select
- `Enter` to confirm selection
- `Esc` to close menu
- Continue typing to filter options

## Status bar

The bottom status bar displays:

- Current time
- Current mode (agent/shell) and model name (displayed in agent mode)
- YOLO indicator (displayed when enabled)
- Shortcut hints
- Context usage rate

The status bar automatically refreshes to update information.

# Keyboard Shortcuts

Kimi Code CLI shell mode supports the following keyboard shortcuts.

## Shortcuts list

| Shortcut | Function |
|----------|----------|
| `Ctrl-X` | Toggle agent/shell mode |
| `Shift-Tab` | Toggle plan mode (read-only research and planning) |
| `Ctrl-O` | Edit in external editor (`$VISUAL`/`$EDITOR`) |
| `Ctrl-J` | Insert newline |
| `Alt-Enter` | Insert newline (same as `Ctrl-J`) |
| `Ctrl-S` | Steer: inject input immediately into the running turn (during streaming) |
| `Ctrl-V` | Paste (supports images and video files) |
| `Ctrl-E` | Expand full approval request content |
| `1`–`4` | Quick select approval option (`4` for decline with feedback) |
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
- Plan mode: `📋`
- Shell mode: `$`

## Plan mode

### `Shift-Tab`: Toggle plan mode

Press `Shift-Tab` to enable or disable plan mode. In plan mode, the AI can only use read-only tools to explore the codebase, writing an implementation plan to a plan file and submitting it for your approval.

When enabled, the prompt changes to `📋` and a blue `plan` badge appears in the status bar. You can also use the `/plan` slash command to manage plan mode. See [Plan mode](../guides/interaction.md#plan-mode) for details.

## External editor

### `Ctrl-O`: Edit in external editor

Press `Ctrl-O` to open an external editor (e.g., VS Code, Vim) to edit the current input content. The editor is selected in the following priority:

1. Editor configured via `/editor` command
2. `$VISUAL` environment variable
3. `$EDITOR` environment variable
4. Auto-detect: `code --wait` (VS Code) → `vim` → `vi` → `nano`

Use the `/editor` command to interactively switch editors, or specify directly, e.g., `/editor vim`.

After saving and exiting the editor, the edited content replaces the current input. If you quit without saving (e.g., `:q!` in Vim), the input remains unchanged. If the input contains pasted text placeholders, the editor automatically expands them to the original text for editing; unmodified portions are re-collapsed into placeholders after saving.

Useful for writing multi-line prompts, complex code snippets, etc.

## Multi-line input

### `Ctrl-J` / `Alt-Enter`: Insert newline

By default, pressing `Enter` submits the input. To enter multi-line content, use:

- `Ctrl-J`: Insert newline at any position
- `Alt-Enter`: Insert newline at any position

Useful for entering multi-line code snippets or formatted text.

## Clipboard operations

### `Ctrl-V`: Paste

Paste clipboard content into the input box. Supports:

- **Text**: In agent mode, text longer than 1000 characters or 15 lines is automatically collapsed into a `[Pasted text #n]` placeholder to keep the input box clean; the full content is expanded and sent to the model when submitting. When using `Ctrl-O` to open an external editor, placeholders are automatically expanded to the original text, and unmodified portions are re-collapsed after saving
- **Images**: Cached to disk and displayed as an `[image:xxx.png,WxH]` placeholder; the actual image data is sent along with the message to the model (requires model image input support)
- **Video files**: File path is inserted as text into the input box (requires model video input support)

::: tip
Image pasting requires the model to support `image_in` capability. Video pasting requires the model to support `video_in` capability.
:::

## Streaming input

### `Ctrl-S`: Steer

During streaming, press `Ctrl-S` to submit the current input (or pop the oldest queued message) and inject it immediately into the running turn's context. The model sees your message right away without waiting for the current turn to end.

If the input box is empty and there are queued messages, `Ctrl-S` pops the oldest queued message and steers it instead.

### `Enter`: Queue

During streaming, pressing `Enter` queues your message for delivery after the current turn completes. The queued message count is shown in the input header (e.g., `── input · 2 queued ──`). Press `↑` on an empty input to recall the last queued message for editing.

## Approval request operations

### `Ctrl-E`: Expand full content

When approval request preview content is truncated, press `Ctrl-E` to view the full content in a fullscreen pager. When preview is truncated, a "... (truncated, ctrl-e to expand)" hint is displayed.

Useful for viewing longer shell commands or file diff content.

### Number key quick selection

In the approval panel, press `1`–`3` to directly select and submit the corresponding approval option without navigating with arrow keys first. Press `4` to enter feedback mode, where you can type a reason for declining and press Enter to submit; the feedback text is passed to the agent to guide its next attempt.

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
- YOLO badge (yellow, when enabled)
- Plan badge (blue, when enabled)
- Shortcut hints
- Context usage progress bar (10 color-coded blocks: green under 70%, yellow 70–84%, red 85%+; token counts shown when available)

The status bar automatically refreshes to update information.

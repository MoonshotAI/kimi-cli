# Slash Commands

Slash commands are built-in commands for Kimi Code CLI, used to control sessions, configuration, and debugging. Enter a command starting with `/` in the input box to trigger.

::: tip Shell mode
Some slash commands are also available in shell mode, including `/help`, `/exit`, `/version`, `/editor`, `/theme`, `/changelog`, `/feedback`, `/export`, `/import`, and `/task`.
:::

## Help and info

### `/help`

Display help information. Shows keyboard shortcuts, all available slash commands, and loaded skills in a fullscreen pager. Press `q` to exit.

Aliases: `/h`, `/?`

### `/version`

Display Kimi Code CLI version number.

### `/changelog`

Display the changelog for recent versions.

Alias: `/release-notes`

### `/feedback`

Submit feedback to help improve Kimi Code CLI. You will be prompted to enter your feedback and submit it. If the network request fails or times out, the command automatically falls back to opening the GitHub Issues page.

## Account and configuration

### `/login`

Log in or configure an API platform. After execution, first select a platform:

- **Kimi Code**: Automatically opens a browser for OAuth authorization
- **Other platforms**: Enter an API key, then select an available model

After configuration, settings are automatically saved to `~/.kimi/config.toml` and reloaded. See [Providers](../configuration/providers.md) for details.

Alias: `/setup`

::: tip
This command is only available when using the default configuration file. If a configuration was specified via `--config` or `--config-file`, this command cannot be used.
:::

### `/logout`

Log out from the current platform. This clears stored credentials and removes related configuration from the config file. After logout, Kimi Code CLI will automatically reload the configuration.

### `/model`

Switch models and thinking mode.

This command first refreshes the available models list from the API platform. When called without arguments, displays an interactive selection interface where you first select a model, then choose whether to enable thinking mode (if the model supports it).

After selection, Kimi Code CLI will automatically update the configuration file and reload.

::: tip
This command is only available when using the default configuration file. If a configuration was specified via `--config` or `--config-file`, this command cannot be used.
:::

### `/editor`

Set the external editor. When called without arguments, displays an interactive selection interface; you can also specify the editor command directly, e.g., `/editor vim`. After configuration, pressing `Ctrl-O` will open this editor to edit the current input content. See [Keyboard shortcuts](./keyboard.md#external-editor) for details.

### `/theme`

Switch the terminal color theme. Kimi Code CLI provides dark and light color palettes, defaulting to dark.

Usage:

- `/theme`: Show the current theme
- `/theme dark`: Switch to dark theme
- `/theme light`: Switch to light theme

After switching, the configuration is saved to `config.toml` and the shell reloads automatically. The light theme adjusts colors for diff highlights, the task browser, the prompt completion menu, the bottom toolbar, and MCP status indicators to work well on light terminal backgrounds. You can also set `theme = "light"` directly in your config file — see [Config files](../configuration/config-files.md).

### `/reload`

Reload the configuration file without exiting Kimi Code CLI.

### `/debug`

Display debug information for the current context, including:
- Number of messages and tokens
- Number of checkpoints
- Complete message history

Debug information is displayed in a pager, press `q` to exit.

### `/usage`

Display API usage and quota information, showing quota usage with progress bars and remaining percentages.

Alias: `/status`

::: tip
This command only works with the Kimi Code platform.
:::

### `/mcp`

Display currently connected MCP servers and loaded tools. See [Model Context Protocol](../customization/mcp.md) for details.

Output includes:
- Server connection status (green indicates connected)
- List of tools provided by each server

### `/hooks`

Display currently configured hooks. See [Hooks](../customization/hooks.md) for details.

Output includes:
- Event types and counts of configured hooks
- Help message (if no hooks are configured)

## Session management

### `/new`

Create a new session and switch to it immediately, without exiting Kimi Code CLI. If the current session has no content, the empty session directory is automatically cleaned up.

### `/sessions`

List all sessions in the current working directory, allowing switching to other sessions.

Alias: `/resume`

Use arrow keys to select a session, press `Enter` to confirm switch, press `Ctrl-C` to cancel.

### `/title`

View or set the current session title. The configured title is shown in the `/sessions` list, making it easier to identify and find sessions.

Alias: `/rename`

Usage:

- `/title`: Show the current session title
- `/title <text>`: Set the session title (max 200 characters)

After the first conversation turn, the title is automatically derived from the user message; once manually set with this command, auto-generation will no longer overwrite it.

### `/undo`

Roll back to a previous turn and retry. An interactive selector shows all historical turns with the user message (truncated to 80 characters). After selecting a turn, Kimi Code CLI forks a new session containing all conversation history **before** that turn and pre-fills the selected turn's user message into the input box for re-editing. The original session is always preserved.

Use arrow keys to navigate, `Enter` to confirm, `Ctrl-C` to cancel.

::: tip Use case
When the API returns a truncated or malformed response that breaks the session, use `/undo` to roll back to a turn before the problem and retry without abandoning the entire session.
:::

### `/fork`

Fork a new session from the current one, copying the entire conversation history. The original session remains unchanged, and the new session becomes the active session. Useful when you want to branch out and try a different direction from the current state.

### `/export`

Export the current session context to a Markdown file for archiving or sharing.

Usage:

- `/export`: Export to the current working directory with an auto-generated filename (format: `kimi-export-<first 8 chars of session ID>-<timestamp>.md`)
- `/export <path>`: Export to the specified path. If the path is a directory, the filename is auto-generated; if it is a file path, the content is written directly to that file

The exported file includes:
- Session metadata (session ID, export time, working directory, message count, token count)
- Conversation overview (topic, number of turns, tool call count)
- Complete conversation history organized by turns, including user messages, AI responses, tool calls, and tool results

### `/import`

Import context from a file or another session into the current session. The imported content is appended as reference context, and the AI can use this information to inform subsequent interactions.

Usage:

- `/import <file_path>`: Import from a file. Supports common text-based formats such as Markdown, plain text, source code, and configuration files; binary files (e.g., images, PDFs, archives) are not supported
- `/import <session_id>`: Import from the specified session ID. Cannot import the current session into itself

### `/clear`

Clear the current session's context and start a new conversation.

Alias: `/reset`

### `/compact`

Manually compact the context to reduce token usage. You can append custom instructions after the command to tell the AI which information to prioritize preserving during compaction, e.g., `/compact preserve database-related discussions`.

When the context is too long, Kimi Code CLI will automatically trigger compaction. This command allows manually triggering the compaction process.

## Skills

### `/skill:<name>`

Load a specific skill, sending the `SKILL.md` content to the Agent as a prompt. This command works for both standard skills and flow skills.

For example:

- `/skill:code-style`: Load code style guidelines
- `/skill:pptx`: Load PPT creation workflow
- `/skill:git-commits fix user login issue`: Load the skill with an additional task description

You can append additional text after the command, which will be added to the skill prompt. See [Agent Skills](../customization/skills.md) for details.

::: tip
Flow skills can also be invoked via `/skill:<name>`, which loads the content as a standard skill without automatically executing the flow. To execute the flow, use `/flow:<name>` instead.
:::

### `/flow:<name>`

Execute a specific flow skill. Flow skills embed an Agent Flow diagram in `SKILL.md`. After execution, the Agent will start from the `BEGIN` node and process each node according to the flow diagram definition until reaching the `END` node.

For example:

- `/flow:code-review`: Execute code review workflow
- `/flow:release`: Execute release workflow

::: tip
Flow skills can also be invoked via `/skill:<name>`, which loads the content as a standard skill without automatically executing the flow.
:::

See [Agent Skills](../customization/skills.md#flow-skills) for details.

## Workspace

### `/add-dir`

Add an additional directory to the workspace scope. Once added, the directory is accessible to all file tools (`ReadFile`, `WriteFile`, `Glob`, `Grep`, `StrReplaceFile`, etc.) and its directory listing is shown in the system prompt. Added directories are persisted with the session state and automatically restored when resuming.

Usage:

- `/add-dir <path>`: Add the specified directory to the workspace
- `/add-dir`: Without arguments, list already added additional directories

::: tip
Directories already within the working directory do not need to be added, as they are already accessible. You can also add directories at startup via the `--add-dir` option. See [`kimi` command](./kimi-command.md#working-directory) for details.
:::

## Others

### `/init`

Analyze the current project and generate an `AGENTS.md` file.

This command starts a temporary sub-session to analyze the codebase structure and generate a project description document, helping the Agent better understand the project.

### `/plan`

Toggle plan mode. In plan mode, the AI can only use read-only tools to explore the codebase, writing an implementation plan to a plan file and submitting it for your approval. See [Plan mode](../guides/interaction.md#plan-mode) for details.

Usage:

- `/plan`: Toggle plan mode
- `/plan on`: Enable plan mode
- `/plan off`: Disable plan mode
- `/plan view`: View the current plan content
- `/plan clear`: Clear the current plan file

When plan mode is enabled, the prompt changes to `📋` and a blue `plan` badge appears in the status bar.

### `/task`

Open the interactive task browser to view, monitor, and manage background tasks.

The task browser is a three-column TUI:

- **Left column**: Task list showing task ID, status, and description
- **Middle column**: Detailed information for the selected task, including ID, status, description, timestamps, exit code, etc.
- **Right column**: Output preview showing the last few lines

Supported keyboard shortcuts:

| Shortcut | Action |
|----------|--------|
| `Enter` / `O` | View the selected task's full output in a pager |
| `S` | Request to stop the selected task (requires confirmation) |
| `Tab` | Toggle filter mode (all / active tasks only) |
| `R` | Refresh the task list |
| `Q` / `Esc` | Exit the browser |

The task browser automatically refreshes every second, showing real-time task status changes.

::: tip
Background tasks are started by the AI using the `Shell` tool with `run_in_background=true`. The system automatically notifies the AI when background tasks complete.
:::

### `/yolo`

Toggle YOLO mode. When enabled, all operations are automatically approved and a yellow YOLO badge appears in the status bar; enter the command again to disable.

::: warning Note
YOLO mode skips all confirmations. Make sure you understand the potential risks.
:::

### `/web`

Switch to Web UI. Kimi Code CLI will start a Web UI server and open the current session in your browser, allowing you to continue the conversation in the Web UI. See [Web UI](./kimi-web.md) for details.

## Command completion

After typing `/` in the input box, a list of available commands is automatically displayed. Continue typing to filter commands with fuzzy matching support, press Enter to select.

For example, typing `/ses` will match `/sessions`, and `/clog` will match `/changelog`. Command aliases are also supported, such as typing `/h` to match `/help`.

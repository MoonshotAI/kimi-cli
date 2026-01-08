# Slash Commands

Slash commands are built-in commands for Kimi CLI, used to control sessions, configuration, and debugging. Enter a command starting with `/` in the input box to trigger.

## Help and info

### `/help`

Display help information, listing all available slash commands.

Aliases: `/h`, `/?`

### `/version`

Display Kimi CLI version number.

### `/release-notes`

Display release notes for recent versions.

### `/feedback`

Open the GitHub Issues page to submit feedback.

## Configuration and debugging

### `/setup`

Start the configuration wizard to set up API platform and model.

Configuration flow:
1. Select an API platform (Kimi Code, Moonshot AI Open Platform, etc.)
2. Enter your API key
3. Select an available model

After configuration, settings are automatically saved to `~/.kimi/config.toml` and reloaded. See [Providers](../configuration/providers.md) for details.

### `/model`

Switch the default model.

This command first refreshes the available models list from the API platform. When called without arguments, displays an interactive selection interface; you can also specify a model name directly, e.g., `/model kimi-k2`.

After selecting a new model, Kimi CLI will automatically update the configuration file and reload.

::: tip
This command is only available when using the default configuration file. If a configuration was specified via `--config` or `--config-file`, this command cannot be used.
:::

### `/reload`

Reload the configuration file without exiting Kimi CLI.

### `/debug`

Display debug information for the current context, including:
- Number of messages and tokens
- Number of checkpoints
- Complete message history

Debug information is displayed in a pager, press `q` to exit.

### `/usage`

Display API usage and quota information.

::: tip
This command only works with the Kimi Code platform.
:::

### `/mcp`

Display currently connected MCP servers and loaded tools. See [Model Context Protocol](../customization/mcp.md) for details.

Output includes:
- Server connection status (green indicates connected)
- List of tools provided by each server

## Session management

### `/sessions`

List all sessions in the current working directory, allowing switching to other sessions.

Alias: `/resume`

Use arrow keys to select a session, press `Enter` to confirm switch, press `Ctrl-C` to cancel.

### `/clear`

Clear the current session's context and start a new conversation.

Alias: `/reset`

### `/compact`

Manually compact the context to reduce token usage.

When the context is too long, Kimi CLI will automatically trigger compaction. This command allows manually triggering the compaction process.

## Skills

### `/skill:<name>`

Load a specific skill, sending the `SKILL.md` content to the Agent as a prompt.

For example:

- `/skill:code-style`: Load code style guidelines
- `/skill:pptx`: Load PPT creation workflow
- `/skill:git-commits fix user login issue`: Load the skill with an additional task description

You can append additional text after the command, which will be added to the skill prompt. See [Agent Skills](../customization/skills.md) for details.

## Others

### `/init`

Analyze the current project and generate an `AGENTS.md` file.

This command starts a temporary sub-session to analyze the codebase structure and generate a project description document, helping the Agent better understand the project.

### `/yolo`

Toggle YOLO mode. When enabled, all operations are automatically approved and a yellow YOLO badge appears in the status bar; enter the command again to disable.

::: warning Note
YOLO mode skips all confirmations. Make sure you understand the potential risks.
:::

## Command completion

After typing `/` in the input box, a list of available commands is automatically displayed. Continue typing to filter commands, press Enter to select.

Commands support alias matching, for example typing `/h` will match `/help`.

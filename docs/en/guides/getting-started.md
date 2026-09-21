# Getting Started

::: danger Warning
**This project is archived.** Kimi CLI is no longer maintained and will stop working. It receives no further updates or security fixes. Please install [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) instead; see the [migration guide](https://moonshotai.github.io/kimi-code/en/guides/migration).
:::

## What is Kimi Code CLI

Kimi Code CLI is an AI agent that runs in the terminal, helping you complete software development tasks and terminal operations. It can read and edit code, execute shell commands, search and fetch web pages, and autonomously plan and adjust actions during execution.

Kimi Code CLI is suited for:

- **Writing and modifying code**: Implementing new features, fixing bugs, refactoring code
- **Understanding projects**: Exploring unfamiliar codebases, answering architecture and implementation questions
- **Automating tasks**: Batch processing files, running builds and tests, executing scripts

Kimi Code CLI supports the following usage modes:

- **[Interactive CLI (`kimi`)](../reference/kimi-command.md)**: Chat with AI in the terminal using natural language or execute shell commands directly
- **[Browser UI (`kimi web`)](../reference/kimi-web.md)**: Open a graphical interface in your local browser, with session management, file references, code highlighting, and more
- **[Agent integration (`kimi acp`)](../reference/kimi-acp.md)**: Run as a service and integrate with [IDEs](./ides.md) and other local agent clients via the [Agent Client Protocol]

::: info Tip
If you encounter issues or have suggestions, please provide feedback on [GitHub Issues](https://github.com/MoonshotAI/kimi-cli/issues).
:::

[Agent Client Protocol]: https://agentclientprotocol.com/

## Installation

Kimi CLI is archived and should no longer be installed. Install [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) instead:

```sh
# Linux / macOS
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

If you have used Kimi CLI before, Kimi Code CLI offers to migrate your config, MCP servers, and sessions on first launch, or you can run `kimi migrate` at any time. See the [migration guide](https://moonshotai.github.io/kimi-code/en/guides/migration) for details.

## Uninstall

After migrating to Kimi Code CLI, uninstall Kimi CLI:

```sh
uv tool uninstall kimi-cli
```

## First run

Run the `kimi` command in the project directory where you want to work to start Kimi Code CLI:

```sh
cd your-project
kimi
```

On first launch, you need to configure your API source. Enter the `/login` command to start configuration:

```
/login
```

After execution, first select a platform. We recommend **Kimi Code**, which automatically opens a browser for OAuth authorization; selecting other platforms requires entering an API key. After configuration, Kimi Code CLI will automatically save the settings and reload. See [Providers](../configuration/providers.md) for details.

Now you can chat with Kimi Code CLI directly using natural language. Try describing a task you want to complete, for example:

```
Show me the directory structure of this project
```

::: tip
If the project doesn't have an `AGENTS.md` file, you can run the `/init` command to have Kimi Code CLI analyze the project and generate this file, helping the AI better understand the project structure and conventions.
:::

Enter `/help` to view all available [slash commands](../reference/slash-commands.md) and usage tips.

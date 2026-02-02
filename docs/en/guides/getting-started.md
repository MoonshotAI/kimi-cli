# Getting started

## What is Kimi Code CLI

Kimi Code CLI is an AI agent that runs in your terminal, helping you complete software development tasks and terminal operations. It can read and edit code, execute shell commands, search and scrape web pages, and autonomously plan and adjust actions during execution.

Kimi Code CLI is suitable for the following scenarios:

- **Writing and modifying code**: Implementing new features, fixing bugs, refactoring code
- **Understanding projects**: Exploring unfamiliar codebases, answering architecture and implementation questions
- **Automating tasks**: Batch processing files, executing builds and tests, running scripts

Kimi Code CLI provides a shell-like interactive experience in the terminal. You can describe requirements in natural language, or switch to shell mode at any time to execute commands directly. In addition to terminal usage, Kimi Code CLI also supports integration into [IDEs](./ides.md) and other local agent clients via [Agent Client Protocol].

::: info Tip
If you encounter issues or have suggestions, feel free to provide feedback on [GitHub Issues](https://github.com/MoonshotAI/kimi-cli/issues).
:::

[Agent Client Protocol]: https://agentclientprotocol.com/

## Installation

Run the installation script to complete the installation. The script will first install [uv](https://docs.astral.sh/uv/) (a Python package management tool), then install Kimi Code CLI via uv:

```sh
# Linux / macOS
curl -LsSf https://code.kimi.com/install.sh | bash
```

```powershell
# Windows (PowerShell)
Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression
```

Verify that the installation was successful:

```sh
kimi --version
```

::: tip Tip
Due to macOS security checking mechanisms, the first time you run the `kimi` command may take longer. You can add your terminal application to "System Settings → Privacy & Security → Developer Tools" to speed up subsequent launches.
:::

If you already have uv installed, you can also run directly:

```sh
uv tool install --python 3.13 kimi-cli
```

::: tip Tip
Kimi Code CLI supports Python 3.12-3.14, but 3.13 is recommended for best compatibility.
:::

## Upgrading and uninstalling

Upgrade to the latest version:

```sh
uv tool upgrade kimi-cli --no-cache
```

Uninstall Kimi Code CLI:

```sh
uv tool uninstall kimi-cli
```

## First run

Run the `kimi` command in the project directory where you want to work to start Kimi Code CLI:

```sh
cd your-project
kimi
```

On first launch, you need to configure the API source. Enter the `/login` command to start configuration:

```
/login
```

After execution, first select the platform. **Kimi Code** is recommended, which will automatically open the browser for OAuth authorization; selecting other platforms requires entering an API key. After configuration is complete, Kimi Code CLI will automatically save settings and reload. See [Platforms and models](../configuration/providers.md) for details.

Now you can directly converse with Kimi Code CLI in natural language. Try describing the task you want to complete, such as:

```
Help me look at the directory structure of this project
```

::: tip Tip
If there is no `AGENTS.md` file in the project, you can run the `/init` command to let Kimi Code CLI analyze the project and generate this file, helping the AI better understand the project structure and conventions.
:::

Enter `/help` to view all available [slash commands](../reference/slash-commands.md) and usage tips.

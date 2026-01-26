# Getting Started

## What is Kimi Code CLI

Kimi Code CLI is an AI agent that runs in the terminal, helping you complete software development tasks and terminal operations. It can read and edit code, execute shell commands, search and fetch web pages, and autonomously plan and adjust actions during execution.

Kimi Code CLI is suited for:

- **Writing and modifying code**: Implementing new features, fixing bugs, refactoring code
- **Understanding projects**: Exploring unfamiliar codebases, answering architecture and implementation questions
- **Automating tasks**: Batch processing files, running builds and tests, executing scripts

Kimi Code CLI provides a shell-like interactive experience in the terminal. You can describe your needs in natural language or switch to shell mode at any time to execute commands directly. Beyond terminal usage, Kimi Code CLI also supports integration with [IDEs](./ides.md) and other local agent clients via the [Agent Client Protocol].

::: warning Note
Kimi Code CLI is currently in technical preview. Features and APIs may change. If you encounter issues or have suggestions, please provide feedback on [GitHub Issues](https://github.com/MoonshotAI/kimi-cli/issues).
:::

[Agent Client Protocol]: https://agentclientprotocol.com/

## Installation

Run the installation script to complete the installation. The script will first install [uv](https://docs.astral.sh/uv/) (a Python package manager), then install Kimi Code CLI via uv:

```sh
# Linux / macOS
curl -LsSf https://cdn.kimi.com/binaries/kimi-cli/install.sh | bash
```

```powershell
# Windows (PowerShell)
Invoke-RestMethod https://cdn.kimi.com/binaries/kimi-cli/install.ps1 | Invoke-Expression
```

Verify the installation:

```sh
kimi --version
```

::: tip
Due to macOS security checks, the first run of the `kimi` command may take longer. You can add your terminal application in "System Settings → Privacy & Security → Developer Tools" to speed up subsequent launches.
:::

If you already have uv installed, you can also run:

```sh
uv tool install --python 3.13 kimi-cli
```

::: tip
Kimi Code CLI supports Python 3.12–3.14, with Python 3.13 recommended.
:::

## Upgrade and uninstall

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

On first launch, you need to configure the API platform and model. Enter the `/setup` command to start the configuration wizard:

1. Select an API platform (e.g., Kimi Code, Moonshot AI Open Platform)
2. Enter your API key
3. Select the model to use

After configuration, Kimi Code CLI will automatically save the settings and reload. See [Providers](../configuration/providers.md) for details.

Now you can chat with Kimi Code CLI directly using natural language. Try describing a task you want to complete, for example:

```
Show me the directory structure of this project
```

::: tip
If the project doesn't have an `AGENTS.md` file, you can run the `/init` command to have Kimi Code CLI analyze the project and generate this file, helping the AI better understand the project structure and conventions.
:::

Enter `/help` to view all available [slash commands](../reference/slash-commands.md) and usage tips.

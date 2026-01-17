# Getting Started

## What is Gitrekt CLI

Gitrekt CLI is an AI agent that runs in the terminal, helping you complete software development tasks and terminal operations. It can read and edit code, execute shell commands, search and fetch web pages, and autonomously plan and adjust actions during execution.

Gitrekt CLI is suited for:

- **Writing and modifying code**: Implementing new features, fixing bugs, refactoring code
- **Understanding projects**: Exploring unfamiliar codebases, answering architecture and implementation questions
- **Automating tasks**: Batch processing files, running builds and tests, executing scripts

Gitrekt CLI provides a shell-like interactive experience in the terminal. You can describe your needs in natural language or switch to shell mode at any time to execute commands directly. Beyond terminal usage, Gitrekt CLI also supports integration with [IDEs](./ides.md) and other local agent clients via the [Agent Client Protocol].

::: warning Note
Gitrekt CLI is currently in technical preview. Features and APIs may change. If you encounter issues or have suggestions, please provide feedback on [GitHub Issues](https://github.com/MoonshotAI/Gitrekt-cli/issues).
:::

[Agent Client Protocol]: https://agentclientprotocol.com/

## Installation

Run the installation script to complete the installation. The script will first install [uv](https://docs.astral.sh/uv/) (a Python package manager), then install Gitrekt CLI via uv:

```sh
# Linux / macOS
curl -LsSf https://cdn.Gitrekt.com/binaries/Gitrekt-cli/install.sh | bash
```

```powershell
# Windows (PowerShell)
Invoke-RestMethod https://cdn.Gitrekt.com/binaries/Gitrekt-cli/install.ps1 | Invoke-Expression
```

Verify the installation:

```sh
Gitrekt --version
```

::: tip
Due to macOS security checks, the first run of the `Gitrekt` command may take longer. You can add your terminal application in "System Settings → Privacy & Security → Developer Tools" to speed up subsequent launches.
:::

If you already have uv installed, you can also run:

```sh
uv tool install --python 3.14 Gitrekt-cli
```

## Upgrade and uninstall

Upgrade to the latest version:

```sh
uv tool upgrade Gitrekt-cli --no-cache
```

Uninstall Gitrekt CLI:

```sh
uv tool uninstall Gitrekt-cli
```

## First run

Run the `Gitrekt` command in the project directory where you want to work to start Gitrekt CLI:

```sh
cd your-project
Gitrekt
```

On first launch, you need to configure the API platform and model. Enter the `/setup` command to start the configuration wizard:

1. Select an API platform (e.g., Gitrekt Code, Moonshot AI Open Platform)
2. Enter your API key
3. Select the model to use

After configuration, Gitrekt CLI will automatically save the settings and reload. See [Providers](../configuration/providers.md) for details.

Now you can chat with Gitrekt CLI directly using natural language. Try describing a task you want to complete, for example:

```
Show me the directory structure of this project
```

::: tip
If the project doesn't have an `AGENTS.md` file, you can run the `/init` command to have Gitrekt CLI analyze the project and generate this file, helping the AI better understand the project structure and conventions.
:::

Enter `/help` to view all available [slash commands](../reference/slash-commands.md) and usage tips.

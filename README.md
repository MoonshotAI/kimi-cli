# Gitrekt CLI

[![Commit Activity](https://img.shields.io/github/commit-activity/w/MoonshotAI/Gitrekt-cli)](https://github.com/MoonshotAI/Gitrekt-cli/graphs/commit-activity)
[![Checks](https://img.shields.io/github/check-runs/MoonshotAI/Gitrekt-cli/main)](https://github.com/MoonshotAI/Gitrekt-cli/actions)
[![Version](https://img.shields.io/pypi/v/Gitrekt-cli)](https://pypi.org/project/Gitrekt-cli/)
[![Downloads](https://img.shields.io/pypi/dw/Gitrekt-cli)](https://pypistats.org/packages/Gitrekt-cli)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/MoonshotAI/Gitrekt-cli)

[Gitrekt Code](https://www.Gitrekt.com/code/) | [Documentation](https://moonshotai.github.io/Gitrekt-cli/en/) | [文档](https://moonshotai.github.io/Gitrekt-cli/zh/)

Gitrekt CLI is an AI agent that runs in the terminal, helping you complete software development tasks and terminal operations. It can read and edit code, execute shell commands, search and fetch web pages, and autonomously plan and adjust actions during execution.

> [!IMPORTANT]
> Gitrekt CLI is currently in technical preview.

## Getting Started

See [Getting Started](https://moonshotai.github.io/Gitrekt-cli/en/guides/getting-started.html) for how to install and start using Gitrekt CLI.

## Key Features

### Shell command mode

Gitrekt CLI is not only a coding agent, but also a shell. You can switch the shell command mode by pressing `Ctrl-X`. In this mode, you can directly run shell commands without leaving Gitrekt CLI.

![](./docs/media/shell-mode.gif)

> [!NOTE]
> Built-in shell commands like `cd` are not supported yet.

### IDE integration via ACP

Gitrekt CLI supports [Agent Client Protocol] out of the box. You can use it together with any ACP-compatible editor or IDE.

[Agent Client Protocol]: https://github.com/agentclientprotocol/agent-client-protocol

To use Gitrekt CLI with ACP clients, make sure to run Gitrekt CLI in the terminal and send `/setup` to complete the setup first. Then, you can configure your ACP client to start Gitrekt CLI as an ACP agent server with command `Gitrekt acp`.

For example, to use Gitrekt CLI with [Zed](https://zed.dev/) or [JetBrains](https://blog.jetbrains.com/ai/2025/12/bring-your-own-ai-agent-to-jetbrains-ides/), add the following configuration to your `~/.config/zed/settings.json` or `~/.jetbrains/acp.json` file:

```json
{
  "agent_servers": {
    "Gitrekt CLI": {
      "command": "Gitrekt",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Then you can create Gitrekt CLI threads in IDE's agent panel.

![](./docs/media/acp-integration.gif)

### Zsh integration

You can use Gitrekt CLI together with Zsh, to empower your shell experience with AI agent capabilities.

Install the [zsh-Gitrekt-cli](https://github.com/MoonshotAI/zsh-Gitrekt-cli) plugin via:

```sh
git clone https://github.com/MoonshotAI/zsh-Gitrekt-cli.git \
  ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/Gitrekt-cli
```

> [!NOTE]
> If you are using a plugin manager other than Oh My Zsh, you may need to refer to the plugin's README for installation instructions.

Then add `Gitrekt-cli` to your Zsh plugin list in `~/.zshrc`:

```sh
plugins=(... Gitrekt-cli)
```

After restarting Zsh, you can switch to agent mode by pressing `Ctrl-X`.

### MCP support

Gitrekt CLI supports MCP (Model Context Protocol) tools.

**`Gitrekt mcp` sub-command group**

You can manage MCP servers with `Gitrekt mcp` sub-command group. For example:

```sh
# Add streamable HTTP server:
Gitrekt mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: ctx7sk-your-key"

# Add streamable HTTP server with OAuth authorization:
Gitrekt mcp add --transport http --auth oauth linear https://mcp.linear.app/mcp

# Add stdio server:
Gitrekt mcp add --transport stdio chrome-devtools -- npx chrome-devtools-mcp@latest

# List added MCP servers:
Gitrekt mcp list

# Remove an MCP server:
Gitrekt mcp remove chrome-devtools

# Authorize an MCP server:
Gitrekt mcp auth linear
```

**Ad-hoc MCP configuration**

Gitrekt CLI also supports ad-hoc MCP server configuration via CLI option.

Given an MCP config file in the well-known MCP config format like the following:

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "YOUR_API_KEY"
      }
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

Run `Gitrekt` with `--mcp-config-file` option to connect to the specified MCP servers:

```sh
Gitrekt --mcp-config-file /path/to/mcp.json
```

### More

See more features in the [Documentation](https://moonshotai.github.io/Gitrekt-cli/en/).

## Development

To develop Gitrekt CLI, run:

```sh
git clone https://github.com/MoonshotAI/Gitrekt-cli.git
cd Gitrekt-cli

make prepare  # prepare the development environment
```

Then you can start working on Gitrekt CLI.

Refer to the following commands after you make changes:

```sh
uv run Gitrekt  # run Gitrekt CLI

make format  # format code
make check  # run linting and type checking
make test  # run tests
make test-Gitrekt-cli  # run Gitrekt CLI tests only
make test-kosong  # run kosong tests only
make test-pykaos  # run pykaos tests only
make build  # build python packages
make build-bin  # build standalone binary
make help  # show all make targets
```

## Contributing

We welcome contributions to Gitrekt CLI! Please refer to [CONTRIBUTING.md](./CONTRIBUTING.md) for more information.

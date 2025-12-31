# `kimi` Command

`kimi` is the main command for Kimi CLI, used to start interactive sessions or execute single queries.

```sh
kimi [OPTIONS] COMMAND [ARGS]
```

## Basic information

| Option | Short | Description |
|--------|-------|-------------|
| `--version` | `-V` | Show version number and exit |
| `--help` | `-h` | Show help message and exit |
| `--verbose` | | Output detailed runtime information |
| `--debug` | | Log debug information (output to `~/.kimi/logs/kimi.log`) |

## Agent configuration

| Option | Description |
|--------|-------------|
| `--agent NAME` | Use built-in agent, options: `default`, `okabe` |
| `--agent-file PATH` | Use custom agent file |

`--agent` and `--agent-file` are mutually exclusive. See [Agents and Subagents](../customization/agents.md) for details.

## Configuration files

| Option | Description |
|--------|-------------|
| `--config STRING` | Load TOML/JSON configuration string |
| `--config-file PATH` | Load configuration file (default `~/.kimi/config.toml`) |

`--config` and `--config-file` are mutually exclusive. Both configuration strings and files support TOML and JSON formats. See [Config Files](../configuration/config-files.md) for details.

## Model selection

| Option | Short | Description |
|--------|-------|-------------|
| `--model NAME` | `-m` | Specify LLM model, overrides default model in config file |

## Working directory

| Option | Short | Description |
|--------|-------|-------------|
| `--work-dir PATH` | `-w` | Specify working directory (default current directory) |

The working directory determines the root directory for file operations. The agent can only read and write files within this directory.

## Session management

| Option | Short | Description |
|--------|-------|-------------|
| `--continue` | `-C` | Continue the previous session in the current working directory |
| `--session ID` | `-S` | Resume session with specified ID, creates new session if not exists |

`--continue` and `--session` are mutually exclusive.

## Input and commands

| Option | Short | Description |
|--------|-------|-------------|
| `--command TEXT` | `-c` | Pass user query, doesn't enter interactive mode |
| `--query TEXT` | `-q` | Alias for `--command` |

When using `--command`, Kimi CLI exits after processing the query (unless `--print` is specified, results are still displayed in interactive mode).

## UI modes

| Option | Description |
|--------|-------------|
| `--print` | Run in print mode (non-interactive), implicitly enables `--yolo` |
| `--quiet` | Shortcut for `--print --output-format text --final-message-only` |
| `--acp` | Run in ACP server mode |
| `--wire` | Run in Wire server mode (experimental) |

The four options are mutually exclusive, only one can be selected. Default is shell mode. See [Print Mode](../customization/print-mode.md) and [Wire Mode](../customization/wire-mode.md) for details.

## Print mode options

The following options are only effective in `--print` mode:

| Option | Description |
|--------|-------------|
| `--input-format FORMAT` | Input format: `text` (default) or `stream-json` |
| `--output-format FORMAT` | Output format: `text` (default) or `stream-json` |
| `--final-message-only` | Only output the final assistant message |

`stream-json` format uses JSONL (one JSON object per line) for programmatic integration.

## MCP configuration

| Option | Description |
|--------|-------------|
| `--mcp-config-file PATH` | Load MCP config file, can be specified multiple times |
| `--mcp-config JSON` | Load MCP config JSON string, can be specified multiple times |

Default loads `~/.kimi/mcp.json` (if exists). See [Model Context Protocol](../customization/mcp.md) for details.

## Approval control

| Option | Short | Description |
|--------|-------|-------------|
| `--yolo` | `-y` | Auto-approve all operations |
| `--yes` | | Alias for `--yolo` |
| `--auto-approve` | | Alias for `--yolo` |

::: warning Note
In YOLO mode, all file modifications and shell commands are automatically executed. Use with caution.
:::

## Thinking mode

| Option | Description |
|--------|-------------|
| `--thinking` | Enable thinking mode |
| `--no-thinking` | Disable thinking mode |

Thinking mode requires model support. If not specified, uses the last session's setting.

## Skills configuration

| Option | Description |
|--------|-------------|
| `--skills-dir PATH` | Specify skills directory (default `~/.kimi/skills`) |

See [Agent Skills](../customization/skills.md) for details.

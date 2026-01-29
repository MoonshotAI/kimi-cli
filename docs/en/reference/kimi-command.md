# `kimi` Command

`kimi` is the main command for Kimi Code CLI, used to start interactive sessions or execute single queries.

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

The working directory determines the root directory for file operations. Relative paths work within the working directory; absolute paths are required to access files outside it.

## Session management

| Option | Short | Description |
|--------|-------|-------------|
| `--continue` | `-C` | Continue the previous session in the current working directory |
| `--session ID` | `-S` | Resume session with specified ID, creates new session if not exists |

`--continue` and `--session` are mutually exclusive.

## Input and commands

| Option | Short | Description |
|--------|-------|-------------|
| `--prompt TEXT` | `-p` | Pass user prompt, doesn't enter interactive mode |
| `--command TEXT` | `-c` | Alias for `--prompt` |

When using `--prompt` (or `--command`), Kimi Code CLI exits after processing the query (unless `--print` is specified, results are still displayed in interactive mode).

## Loop control

| Option | Description |
|--------|-------------|
| `--max-steps-per-turn N` | Maximum steps per turn, overrides `loop_control.max_steps_per_turn` in config file |
| `--max-retries-per-step N` | Maximum retries per step, overrides `loop_control.max_retries_per_step` in config file |
| `--max-ralph-iterations N` | Number of iterations for Ralph Loop mode; `0` disables; `-1` is unlimited |

### Ralph Loop

[Ralph](https://ghuntley.com/ralph/) is a technique that puts an agent in a loop: the same prompt is fed again and again so the agent can keep iterating one big task.

When `--max-ralph-iterations` is not `0`, Kimi Code CLI enters Ralph Loop mode and automatically loops through task execution until the agent outputs `<choice>STOP</choice>` or the iteration limit is reached.

## UI modes

| Option | Description |
|--------|-------------|
| `--print` | Run in print mode (non-interactive), implicitly enables `--yolo` |
| `--quiet` | Shortcut for `--print --output-format text --final-message-only` |
| `--acp` | Run in ACP server mode (deprecated, use `kimi acp` instead) |
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
| `--skills-dir PATH` | Specify skills directory, skipping auto-discovery |

When not specified, Kimi Code CLI automatically discovers user-level and project-level skills directories in priority order. See [Agent Skills](../customization/skills.md) for details.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| [`kimi login`](#kimi-login) | Log in to your Kimi account |
| [`kimi logout`](#kimi-logout) | Log out from your Kimi account |
| [`kimi info`](./kimi-info.md) | Display version and protocol information |
| [`kimi acp`](./kimi-acp.md) | Start multi-session ACP server |
| [`kimi mcp`](./kimi-mcp.md) | Manage MCP server configuration |
| [`kimi term`](./kimi-term.md) | Launch the Toad terminal UI |
| [`kimi web`](./kimi-web.md) | Start the Web UI server |

### `kimi login`

Log in to your Kimi account. This automatically opens a browser; complete account authorization and available models will be automatically configured.

```sh
kimi login
```

### `kimi logout`

Log out from your Kimi account. This clears stored OAuth credentials and removes related configuration from the config file.

```sh
kimi logout
```

### `kimi web`

Start the Web UI server to access Kimi Code CLI through a browser.

```sh
kimi web [OPTIONS]
```

If the default port is in use, the server will pick the next available port (by default `5494`–`5503`) and print a notice in the terminal.

| Option | Short | Description |
|--------|-------|-------------|
| `--host TEXT` | `-h` | Host address to bind to (default: `127.0.0.1`) |
| `--port INTEGER` | `-p` | Port number to bind to (default: `5494`) |
| `--reload` | | Enable auto-reload (development mode) |
| `--open / --no-open` | | Automatically open browser (default: enabled) |

Examples:

```sh
# Default startup, automatically opens browser
kimi web

# Specify port
kimi web --port 8080

# Don't automatically open browser
kimi web --no-open

# Bind to all network interfaces (allow LAN access)
kimi web --host 0.0.0.0
```

See [Web UI](./kimi-web.md) for details.

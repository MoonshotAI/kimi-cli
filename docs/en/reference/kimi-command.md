# `Gitrekt` Command

`Gitrekt` is the main command for Gitrekt CLI, used to start interactive sessions or execute single queries.

```sh
Gitrekt [OPTIONS] COMMAND [ARGS]
```

## Basic information

| Option | Short | Description |
|--------|-------|-------------|
| `--version` | `-V` | Show version number and exit |
| `--help` | `-h` | Show help message and exit |
| `--verbose` | | Output detailed runtime information |
| `--debug` | | Log debug information (output to `~/.Gitrekt/logs/Gitrekt.log`) |

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
| `--config-file PATH` | Load configuration file (default `~/.Gitrekt/config.toml`) |

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
| `--prompt TEXT` | `-p` | Pass user prompt, doesn't enter interactive mode |
| `--command TEXT` | `-c` | Alias for `--prompt` |

When using `--prompt` (or `--command`), Gitrekt CLI exits after processing the query (unless `--print` is specified, results are still displayed in interactive mode).

## Loop control

| Option | Description |
|--------|-------------|
| `--max-steps-per-turn N` | Maximum steps per turn, overrides `loop_control.max_steps_per_turn` in config file |
| `--max-retries-per-step N` | Maximum retries per step, overrides `loop_control.max_retries_per_step` in config file |
| `--max-ralph-iterations N` | Number of iterations for Ralph Loop mode; `0` disables; `-1` is unlimited |

### Ralph Loop

[Ralph](https://ghuntley.com/ralph/) is a technique that puts an agent in a loop: the same prompt is fed again and again so the agent can keep iterating one big task.

When `--max-ralph-iterations` is not `0`, Gitrekt CLI enters Ralph Loop mode and automatically loops through task execution based on an internal Prompt Flow, until the agent outputs `<choice>STOP</choice>` or the iteration limit is reached.

::: info Note
Ralph Loop is mutually exclusive with the `--prompt-flow` option and cannot be used together.
:::

## Prompt Flow

| Option | Description |
|--------|-------------|
| `--prompt-flow PATH` | Load a D2 (`.d2`) or Mermaid (`.mmd`) flowchart file as a Prompt Flow |

Prompt Flow is a prompt workflow description method based on flowcharts, where each node corresponds to one conversation turn. After loading, you can start the flow execution with the `/begin` slash command. Both D2 and Mermaid flowchart formats are supported. You can edit and preview D2 flowcharts at [D2 Playground](https://play.d2lang.com), and Mermaid flowcharts at [Mermaid Playground](https://www.mermaidchart.com/play).

D2 flowchart example (`example.d2` file):

```
BEGIN -> B -> C
B: Analyze existing code, write design doc for XXX feature in design.md
C: Review design.md, is it detailed enough?
C -> B: No
C -> D: Yes
D: Start implementation
D -> END
```

Mermaid flowchart example (`example.mmd` file):

```
flowchart TD
A([BEGIN]) --> B[Analyze existing code, write design doc for XXX feature in design.md]
B --> C{Review design.md, is it detailed enough?}
C -->|Yes| D[Start implementation]
C -->|No| B
D --> F([END])
```

```mermaid
flowchart TD
A([BEGIN]) --> B[Analyze existing code, write design doc for XXX feature in design.md]
B --> C{Review design.md, is it detailed enough?}
C -->|Yes| D[Start implementation]
C -->|No| B
D --> F([END])
```

During node processing, decision nodes require the agent to output `<choice>branch name</choice>` to select the next node.

::: info Note
`--prompt-flow` is mutually exclusive with Ralph Loop mode and cannot be used together.
:::

## UI modes

| Option | Description |
|--------|-------------|
| `--print` | Run in print mode (non-interactive), implicitly enables `--yolo` |
| `--quiet` | Shortcut for `--print --output-format text --final-message-only` |
| `--acp` | Run in ACP server mode (deprecated, use `Gitrekt acp` instead) |
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

Default loads `~/.Gitrekt/mcp.json` (if exists). See [Model Context Protocol](../customization/mcp.md) for details.

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
| `--skills-dir PATH` | Specify skills directory (default `~/.Gitrekt/skills`) |

See [Agent Skills](../customization/skills.md) for details.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| [`Gitrekt info`](./Gitrekt-info.md) | Display version and protocol information |
| [`Gitrekt acp`](./Gitrekt-acp.md) | Start multi-session ACP server |
| [`Gitrekt mcp`](./Gitrekt-mcp.md) | Manage MCP server configuration |
| [`Gitrekt term`](./Gitrekt-term.md) | Launch the Toad terminal UI |

# Agent Tracing Visualizer

::: warning Note
Agent Tracing Visualizer is currently in Technical Preview and may be unstable. Features and interface may change in future releases.
:::

Agent Tracing Visualizer is a browser-based visualization dashboard for inspecting and analyzing Kimi Code CLI session traces. It helps you understand agent behavior, view Wire event timelines, analyze context usage, and browse historical sessions.

## Launch

Run `kimi vis` in the terminal to start the Visualizer:

```sh
kimi vis
```

The server automatically opens a browser after startup. The default address is `http://127.0.0.1:5495`.

If the default port is in use, the server will pick the next available port (by default `5495`–`5504`) and print the access URL in the terminal.

## Command-line options

| Option | Short | Description |
|--------|-------|-------------|
| `--port INTEGER` | `-p` | Port number to bind to (default: `5495`) |
| `--open / --no-open` | | Automatically open browser (default: `--open`) |
| `--reload` | | Enable auto-reload (development mode) |

Examples:

```sh
# Specify port
kimi vis --port 8080

# Don't automatically open browser
kimi vis --no-open
```

## Features

### Wire event timeline

Displays the complete Wire event flow as a timeline, including turn start/end, step execution, tool calls and results. Supports event filtering and detailed information viewing.

### Context viewer

Visualizes session context content, including user messages, assistant messages, and tool calls. Helps you understand what the agent "sees" at each step.

### Session explorer

Browse and search all historical sessions, grouped by project. View detailed information for each session, including working directory, creation time, and message count.

### Usage statistics

Displays token usage statistics and charts, including input/output token distribution and cache hit rates.

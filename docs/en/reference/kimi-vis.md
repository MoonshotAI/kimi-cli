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

You can also type `/vis` in the interactive shell to switch directly from the current session to the Visualizer.

## Command-line options

| Option | Short | Description |
|--------|-------|-------------|
| `--host TEXT` | `-h` | Bind to a specific IP address |
| `--network` | `-n` | Enable network access (bind to `0.0.0.0`), auto-detects and displays LAN IP |
| `--port INTEGER` | `-p` | Port number to bind to (default: `5495`) |
| `--open / --no-open` | | Automatically open browser (default: `--open`) |
| `--reload` | | Enable auto-reload (development mode) |

Examples:

```sh
# Specify port
kimi vis --port 8080

# Don't automatically open browser
kimi vis --no-open

# Share on LAN (auto-detects and displays LAN IP)
kimi vis -n
```

## Features

### Wire event timeline

Displays the complete Wire event flow as a timeline, including turn start/end, step execution, tool calls and results. Supports event filtering and detailed information viewing.

### Context viewer

Visualizes session context content, including user messages, assistant messages, and tool calls. Helps you understand what the agent "sees" at each step.

### Session explorer

Browse and search all historical sessions, grouped by project. View detailed information for each session, including working directory, creation time, and message count.

### Session directory shortcuts

At the top of the session detail page, you can use `Open Dir` to open the current session directory directly. On macOS this opens Finder; on Windows it opens Explorer. `Copy DIR` copies the raw session directory path so you can continue debugging in a terminal, editor, or issue report.

### Session download and export

You can export session data as a ZIP file for offline analysis or sharing.

- **ZIP download**: Click the download button in the session explorer or session detail page to download the session directory as a ZIP file
- **CLI export**: Use the `kimi export <session_id>` command to export a specified session as a ZIP file

### Session import

Supports importing ZIP-format session data into the Visualizer for viewing. Imported sessions are stored in a dedicated `~/.kimi/imported_sessions/` directory, separate from regular sessions.

In the session explorer, you can use the "Imported" filter toggle to switch between viewing imported sessions. Imported sessions support deletion, with a confirmation dialog before removal.

### Usage statistics

Displays token usage statistics and charts, including input/output token distribution and cache hit rates.

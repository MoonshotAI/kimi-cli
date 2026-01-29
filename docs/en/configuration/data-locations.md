# Data Locations

Kimi Code CLI stores all data in the `~/.kimi/` directory under the user's home directory. This page describes the locations and purposes of various data files.

## Directory structure

```
~/.kimi/
├── config.toml           # Main configuration file
├── kimi.json             # Metadata
├── mcp.json              # MCP server configuration
├── sessions/             # Session data
│   └── <work-dir-hash>/
│       └── <session-id>/
│           ├── context.jsonl
│           └── wire.jsonl
├── user-history/         # Input history
│   └── <work-dir-hash>.jsonl
└── logs/                 # Logs
    └── kimi.log
```

## Configuration and metadata

### `config.toml`

Main configuration file, stores providers, models, services, and runtime parameters. See [Config Files](./config-files.md) for details.

You can specify a configuration file at a different location with the `--config-file` flag.

### `kimi.json`

Metadata file, stores Kimi Code CLI's runtime state, including:

- `work_dirs`: List of working directories and their last used session IDs
- `thinking`: Whether thinking mode was enabled in the last session

This file is automatically managed by Kimi Code CLI and typically doesn't need manual editing.

### `mcp.json`

MCP server configuration file, stores MCP servers added via the `kimi mcp add` command. See [MCP](../customization/mcp.md) for details.

Example structure:

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "transport": "http",
      "headers": {
        "CONTEXT7_API_KEY": "ctx7sk-xxx"
      }
    }
  }
}
```

## Session data

Session data is grouped by working directory and stored under `~/.kimi/sessions/`. Each working directory corresponds to a subdirectory named with the path's MD5 hash, and each session corresponds to a subdirectory named with the session ID.

### `context.jsonl`

Context history file, stores the session's message history in JSON Lines (JSONL) format. Each line is a message (user input, model response, tool calls, etc.).

Kimi Code CLI uses this file to restore session context when using `--continue` or `--session`.

### `wire.jsonl`

Wire message log file, stores Wire events during the session in JSON Lines (JSONL) format. Used for session replay and extracting session titles.

## Input history

User input history is stored in the `~/.kimi/user-history/` directory. Each working directory corresponds to a `.jsonl` file named with the path's MD5 hash.

Input history is used for history browsing (up/down arrow keys) and search (Ctrl-R) in shell mode.

## Logs

Runtime logs are stored in `~/.kimi/logs/kimi.log`. Default log level is INFO, use the `--debug` flag to enable TRACE level.

Log files are used for troubleshooting. When reporting bugs, please include relevant log content.

## Cleaning data

Deleting the `~/.kimi/` directory completely clears all Kimi Code CLI data, including configuration, sessions, and history.

To clean only specific data:

| Need | Action |
| --- | --- |
| Reset configuration | Delete `~/.kimi/config.toml` |
| Clear all sessions | Delete `~/.kimi/sessions/` directory |
| Clear sessions for specific working directory | Use `/sessions` in shell mode to view and delete |
| Clear input history | Delete `~/.kimi/user-history/` directory |
| Clear logs | Delete `~/.kimi/logs/` directory |
| Clear MCP configuration | Delete `~/.kimi/mcp.json` or use `kimi mcp remove` |

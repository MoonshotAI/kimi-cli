# `kimi web` Command

`kimi web` starts the Web UI server, allowing you to use Kimi Code CLI in a browser.

```sh
kimi web [OPTIONS]
```

## Usage

### Basic usage

Run the following command in your project directory to start the Web UI:

```sh
kimi web
```

After starting, the browser will automatically open to access the Web interface. The default address is `http://127.0.0.1:5494`.
If the default port is occupied, the server will automatically try the next available port (by default `5494`–`5503`) and print a notice in the terminal.

### Common options

| Option | Short | Description |
|--------|-------|-------------|
| `--host TEXT` | `-h` | Host address to bind to (default: `127.0.0.1`) |
| `--port INTEGER` | `-p` | Port number to bind to (default: `5494`) |
| `--open / --no-open` | | Whether to automatically open browser (default: `--open`) |

### Development mode

```sh
# Enable auto-reload (server restarts automatically after code changes)
kimi web --reload
```

## Features

The Web UI provides functionality similar to the terminal Shell mode:

- **Chat interface**: Have natural language conversations with Kimi Code CLI
- **Session management**: Create, switch, and manage multiple sessions
- **File operations**: Upload and view files
- **Approval control**: Approve or reject Agent operation requests
- **Configuration management**: Adjust settings such as thinking mode

## LAN access

To allow access from other devices on the local network, bind to `0.0.0.0`:

```sh
kimi web --host 0.0.0.0
```

::: warning Security note
Opening access on public networks may pose security risks. It is recommended to use this only in trusted network environments.
:::

# Web UI

Web UI provides a browser-based interactive interface, allowing you to use all features of Kimi Code CLI in a web page. Compared to the terminal interface, Web UI offers a richer visual experience, more flexible session management, and more convenient file operations.

## Starting Web UI

Run the `kimi web` command in your terminal to start the Web UI server:

```sh
kimi web
```

After the server starts, it will automatically open your browser to access the Web UI. The default address is `http://127.0.0.1:5494`.

If the default port is occupied, the server will automatically try the next available port (default range `5494`–`5503`) and print the access address in the terminal.

## Command line options

### Network configuration

| Option | Short | Description |
|--------|-------|-------------|
| `--host TEXT` | `-h` | Bind to specific IP address |
| `--network` | `-n` | Enable network access (bind to `0.0.0.0`) |
| `--port INTEGER` | `-p` | Specify port number (default: `5494`) |

By default, Web UI only listens on the local loopback address `127.0.0.1`, allowing access only from the local machine.

If you want to access Web UI from a local network or the public internet, you can use the `--network` option or specify `--host`:

```sh
# Bind to all network interfaces, allowing LAN access
kimi web --network

# Bind to a specific IP address
kimi web --host 192.168.1.100
```

::: warning Note
When enabling network access, be sure to configure access control options (such as `--auth-token` and `--lan-only`) to ensure security. See [Access control](#access-control).
:::

### Browser control

| Option | Description |
|--------|-------------|
| `--open / --no-open` | Automatically open browser on startup (default: `--open`) |

Use `--no-open` to prevent automatically opening the browser:

```sh
kimi web --no-open
```

### Development options

| Option | Description |
|--------|-------------|
| `--reload` | Enable auto-reload (for development) |

Use `--reload` to automatically restart the server after code changes:

```sh
kimi web --reload
```

::: info Note
The `--reload` option is only for development purposes and is not needed for daily use.
:::

### Access control

Web UI provides multi-layer access control mechanisms to ensure service security.

| Option | Description |
|--------|-------------|
| `--auth-token TEXT` | Set Bearer Token for API authentication |
| `--allowed-origins TEXT` | Set allowed Origin list (comma-separated) |
| `--lan-only / --public` | Only allow LAN access (default) or allow public access |
| `--restrict-sensitive-apis / --no-restrict-sensitive-apis` | Restrict sensitive API access (config write, open-in, file access limits) |
| `--dangerously-omit-auth` | Disable authentication checks (dangerous, trusted networks only) |

::: info Added
Access control options added in version 1.6.
:::

#### Access token authentication

Use `--auth-token` to set an access token. Clients need to include `Authorization: Bearer <token>` in the HTTP request header to access the API:

```sh
kimi web --network --auth-token my-secret-token
```

::: tip Tip
The access token should be a randomly generated string with at least 32 characters. You can use `openssl rand -hex 32` to generate a random token.
:::

#### Origin checking

Use `--allowed-origins` to restrict the origin domains that can access Web UI:

```sh
kimi web --network --allowed-origins "https://example.com,https://app.example.com"
```

::: tip Tip
When using `--network` or `--host` to enable network access, it is recommended to configure `--allowed-origins` to prevent Cross-Site Request Forgery (CSRF) attacks.
:::

#### Network access scope

By default, Web UI uses `--lan-only` mode, only allowing access from the local network (private IP address ranges). If you need to allow public access, use the `--public` option:

```sh
kimi web --network --public --auth-token my-secret-token
```

::: danger Warning
Using the `--public` option will allow access from any IP address. Be sure to configure `--auth-token` and `--allowed-origins` to ensure security.
:::

#### Restricting sensitive APIs

Use `--restrict-sensitive-apis` to disable some sensitive API features:

- Config file writing
- Open-in functionality (opening local files, directories, applications)
- File access restrictions

```sh
kimi web --network --restrict-sensitive-apis
```

In `--public` mode, `--restrict-sensitive-apis` is enabled by default; in `--lan-only` mode (default), it is not enabled.

::: tip Tip
When you need to expose Web UI to untrusted network environments, it is recommended to enable the `--restrict-sensitive-apis` option.
:::

#### Disabling authentication (not recommended)

In trusted private network environments, you can use `--dangerously-omit-auth` to skip all authentication checks:

```sh
kimi web --dangerously-omit-auth
```

::: danger Warning
The `--dangerously-omit-auth` option completely disables authentication and access control. It should only be used in fully trusted network environments (such as offline local development environments). Do not use this option on the public internet or untrusted local networks.
:::

## Switching from terminal to Web UI

If you are using Kimi Code CLI in shell mode in the terminal, you can enter the `/web` command to quickly switch to Web UI:

```
/web
```

After execution, Kimi Code CLI will automatically start the Web UI server and open the current session in the browser. You can continue the conversation in Web UI, and the session history will remain synchronized.

## Web UI features

### Session management

Web UI provides a convenient session management interface:

- **Session list**: View all historical sessions, including session title and working directory
- **Session search**: Quickly filter sessions by title or working directory
- **Create session**: Create a new session with a specified working directory; if the specified path doesn't exist, you will be prompted to confirm creating the directory
- **Switch session**: Switch to different sessions with one click

::: info Added
Session search feature added in version 1.5. Directory auto-creation prompt added in version 1.7.
:::

### Git status bar

Web UI detects Git repository status in the session working directory and displays uncommitted change statistics at the top of the interface:

- Number of new files (including staged new files and untracked files)
- Number of modified files
- Number of deleted files

Click the status bar to view a detailed list of file changes.

::: info Added
Git status bar added in version 1.5.
:::

### Open-in functionality

Web UI supports opening files or directories in local applications:

- **Open in Terminal**: Open directory in terminal
- **Open in VS Code**: Open file or directory in VS Code
- **Open in Cursor**: Open file or directory in Cursor
- **Open in System**: Open with system default application

::: info Added
Open-in functionality added in version 1.5.
:::

::: warning Note
Open-in functionality requires browser support for Custom Protocol Handler. This feature is disabled when using the `--restrict-sensitive-apis` option.
:::

### Slash commands

Web UI supports slash commands. Type `/` in the input box to open the command menu:

- **Autocomplete**: Filter matching commands as you type
- **Keyboard navigation**: Use up/down arrow keys to select commands, Enter to confirm
- **Alias support**: Support command alias matching, e.g., `/h` matches `/help`

### File mentions

Web UI supports file mentions. Type `@` in the input box to open the file mention menu, allowing you to reference files in your conversation:

- **Uploaded attachments**: Mention files attached to the current message
- **Workspace files**: Mention existing files in the current session's working directory
- **Autocomplete**: Filter matching files by name or path as you type
- **Keyboard navigation**: Use up/down arrow keys to select files, Enter or Tab to confirm, Escape to cancel

### Rich media support

Web UI supports viewing and pasting various types of rich media content:

- **Images**: Display images directly in the chat interface
- **Code highlighting**: Automatic code block recognition and highlighting
- **Markdown rendering**: Support for full Markdown syntax

### Responsive layout

Web UI uses responsive design and displays well on screens of different sizes:

- Desktop: Sidebar + main content area layout
- Mobile: Collapsible drawer-style sidebar

::: info Changed
Responsive layout improved in version 1.6 with enhanced hover effects and better layout handling.
:::

## Examples

### Local use

The simplest usage, accessible only from the local machine:

```sh
kimi web
```

### LAN sharing

Share Web UI on the local network with access token protection:

```sh
kimi web --network --auth-token $(openssl rand -hex 32)
```

After execution, the terminal will display the access address and token. Other devices can access through that address and enter the token in the browser for authentication.

### Public access

Deploy Web UI in a public internet environment (requires careful security configuration):

```sh
kimi web \
  --host 0.0.0.0 \
  --public \
  --auth-token $(openssl rand -hex 32) \
  --allowed-origins "https://yourdomain.com" \
  --restrict-sensitive-apis
```

### Development

Enable auto-reload for development purposes:

```sh
kimi web --reload --no-open
```

## Technical details

Web UI is built on the following technologies:

- **Backend**: FastAPI + WebSocket
- **Frontend**: React + TypeScript + Vite
- **API protocol**: Complies with OpenAPI specification, see `web/openapi.json`

Web UI communicates with Kimi Code CLI's Wire mode via WebSocket, enabling real-time bidirectional data transmission.

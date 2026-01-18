# `kimi mcp` Subcommand

`kimi mcp` is used to manage MCP (Model Context Protocol) server configurations. For concepts and usage of MCP, see [Model Context Protocol](../customization/mcp.md).

```sh
kimi mcp COMMAND [ARGS]
```

## `add`

Add an MCP server configuration.

```sh
kimi mcp add [OPTIONS] NAME [TARGET_OR_COMMAND...]
```

**Arguments**

| Argument | Description |
|----------|-------------|
| `NAME` | Server name, used for identification and reference |
| `TARGET_OR_COMMAND...` | URL for `http` mode; command for `stdio` mode (must start with `--`) |

**Options**

| Option | Short | Description |
|--------|-------|-------------|
| `--transport TYPE` | `-t` | Transport type: `stdio` (default) or `http` |
| `--env KEY=VALUE` | `-e` | Environment variable (`stdio` only), can be specified multiple times |
| `--header KEY:VALUE` | `-H` | HTTP header (`http` only), can be specified multiple times |
| `--auth TYPE` | `-a` | Authentication type (e.g., `oauth`, `http` only) |

## `list`

List all configured MCP servers.

```sh
kimi mcp list
```

Output includes:
- Configuration file path
- Name, transport type, and target for each server
- Authorization status for OAuth servers

## `remove`

Remove an MCP server configuration.

```sh
kimi mcp remove NAME
```

**Arguments**

| Argument | Description |
|----------|-------------|
| `NAME` | Name of server to remove |

## `auth`

Authorize an MCP server that uses OAuth.

```sh
kimi mcp auth NAME
```

This will open a browser for the OAuth authorization flow. After successful authorization, the token is cached for future use.

**Arguments**

| Argument | Description |
|----------|-------------|
| `NAME` | Name of server to authorize |

::: tip
Only servers added with `--auth oauth` require this command.
:::

## `reset-auth`

Clear the cached OAuth token for an MCP server.

```sh
kimi mcp reset-auth NAME
```

**Arguments**

| Argument | Description |
|----------|-------------|
| `NAME` | Name of server to reset authorization |

After clearing, you need to run `kimi mcp auth` again to re-authorize.

## `test`

Test connection to an MCP server and list available tools.

```sh
kimi mcp test NAME
```

**Arguments**

| Argument | Description |
|----------|-------------|
| `NAME` | Name of server to test |

Output includes:
- Connection status
- Number of available tools
- Tool names and descriptions

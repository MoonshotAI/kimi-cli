# Model Context Protocol

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open protocol that enables AI models to securely interact with external tools and data sources. Kimi Code CLI supports connecting to MCP servers to extend AI capabilities.

## What is MCP

MCP servers provide "tools" for AI to use. For example, a database MCP server can provide query tools that allow AI to execute SQL queries; a browser MCP server can let AI control the browser for automation.

Kimi Code CLI has some built-in tools (file read/write, shell commands, web scraping, etc.), and through MCP you can add more tools, such as:

- Accessing specific APIs or databases
- Controlling browsers or other applications
- Integrating with third-party services (GitHub, Linear, Notion, etc.)

## MCP server management

Use the [`kimi mcp`](../reference/kimi-mcp.md) command to manage MCP servers.

**Add server**

Add HTTP server:

```sh
# Basic usage
kimi mcp add --transport http context7 https://mcp.context7.com/mcp

# With header
kimi mcp add --transport http context7 https://mcp.context7.com/mcp \
  --header "CONTEXT7_API_KEY: your-key"

# Using OAuth authentication
kimi mcp add --transport http --auth oauth linear https://mcp.linear.app/mcp
```

Add stdio server (local process):

```sh
kimi mcp add --transport stdio chrome-devtools -- npx chrome-devtools-mcp@latest
```

**List servers**

```sh
kimi mcp list
```

While Kimi Code CLI is running, you can also type `/mcp` to view connected servers and loaded tools.

**Remove server**

```sh
kimi mcp remove context7
```

**OAuth authorization**

For servers using OAuth, authorization needs to be completed first:

```sh
kimi mcp auth linear
```

This will open the browser to complete the OAuth flow. After successful authorization, Kimi Code CLI will save the token for subsequent use.

**Test server**

```sh
kimi mcp test context7
```

## MCP configuration file

MCP server configurations are stored in `~/.kimi/mcp.json`, with a format compatible with other MCP clients:

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "your-key"
      }
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest"],
      "env": {
        "SOME_VAR": "value"
      }
    }
  }
}
```

**Temporarily load configuration**

Use the `--mcp-config-file` argument to load a configuration file from another location:

```sh
kimi --mcp-config-file /path/to/mcp.json
```

Use the `--mcp-config` argument to pass JSON configuration directly:

```sh
kimi --mcp-config '{"mcpServers": {"test": {"url": "https://..."}}}'
```

## Security

MCP tools may access and manipulate external systems, so security risks need to be considered.

**Approval mechanism**

Kimi Code CLI requests user confirmation for sensitive operations (such as file modifications, command execution). MCP tools follow the same approval mechanism, and all MCP tool calls will show a confirmation prompt.

**Prompt injection risks**

MCP tool return content may contain malicious instructions attempting to induce AI to perform dangerous operations. Kimi Code CLI marks tool return content to help AI distinguish between tool output and user instructions, but you should still:

- Only use MCP servers from trusted sources
- Check whether AI-proposed operations are reasonable
- Maintain manual approval for high-risk operations

::: warning Warning
In YOLO mode, MCP tool operations will also be auto-approved. It is recommended to only use YOLO mode when you fully trust the MCP server.
:::

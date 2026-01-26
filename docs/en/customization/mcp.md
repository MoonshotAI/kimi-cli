# Model Context Protocol

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open protocol that allows AI models to safely interact with external tools and data sources. Kimi Code CLI supports connecting to MCP servers to extend AI capabilities.

## What is MCP

MCP servers provide "tools" for AI to use. For example, a database MCP server can provide query tools that allow AI to execute SQL queries; a browser MCP server can let AI control browsers for automation tasks.

Kimi Code CLI has built-in tools (file read/write, shell commands, web fetching, etc.). Through MCP, you can add more tools, such as:

- Accessing specific APIs or databases
- Controlling browsers or other applications
- Integrating with third-party services (GitHub, Linear, Notion, etc.)

## MCP server management

Use the [`kimi mcp`](../reference/kimi-mcp.md) command to manage MCP servers.

**Add a server**

Add an HTTP server:

```sh
# Basic usage
kimi mcp add --transport http context7 https://mcp.context7.com/mcp

# With headers
kimi mcp add --transport http context7 https://mcp.context7.com/mcp \
  --header "CONTEXT7_API_KEY: your-key"

# Using OAuth authentication
kimi mcp add --transport http --auth oauth linear https://mcp.linear.app/mcp
```

Add a stdio server (local process):

```sh
kimi mcp add --transport stdio chrome-devtools -- npx chrome-devtools-mcp@latest
```

**List servers**

```sh
kimi mcp list
```

While Kimi Code CLI is running, you can also enter `/mcp` to view connected servers and loaded tools.

**Remove a server**

```sh
kimi mcp remove context7
```

**OAuth authorization**

For servers using OAuth, you need to complete authorization first:

```sh
kimi mcp auth linear
```

This will open a browser to complete the OAuth flow. After successful authorization, Kimi Code CLI will save the token for future use.

**Test a server**

```sh
kimi mcp test context7
```

## MCP configuration file

MCP server configuration is stored in `~/.kimi/mcp.json`, in a format compatible with other MCP clients:

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

**Temporary configuration loading**

Use the `--mcp-config-file` flag to load a configuration file from another location:

```sh
kimi --mcp-config-file /path/to/mcp.json
```

Use the `--mcp-config` flag to pass JSON configuration directly:

```sh
kimi --mcp-config '{"mcpServers": {"test": {"url": "https://..."}}}'
```

## Security

MCP tools may access and operate external systems. Be aware of security risks.

**Approval mechanism**

Kimi Code CLI requests user confirmation for sensitive operations (such as file modifications and command execution). MCP tools follow the same approval mechanism, with all MCP tool calls prompting for confirmation.

**Prompt injection risks**

Content returned by MCP tools may contain malicious instructions attempting to trick the AI into performing dangerous operations. Kimi Code CLI marks tool return content to help the AI distinguish between tool output and user instructions, but you should still:

- Only use MCP servers from trusted sources
- Check whether AI-proposed operations are reasonable
- Keep manual approval for high-risk operations

::: warning Note
In YOLO mode, MCP tool operations will also be automatically approved. It's recommended to only use YOLO mode when you fully trust the MCP servers.
:::

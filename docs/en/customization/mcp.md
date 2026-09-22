# Model Context Protocol

## Install (SHA-256)

Pin GitHub Release **v0.6.0** and verify `SHA256SUMS`. Website `install.sh` / `install.ps1` abort on mismatch.

https://github.com/LinespottingOrg/GrokBuildRemote-Agents/releases/tag/v0.6.0
https://github.com/LinespottingOrg/GrokBuildRemote-Agents/blob/main/docs/PINNED-INSTALL.md

```
96cef605d3e030ccef99d27ea6240e0d3b668dd045e6b5b9e585c9fd03c6ef23  gbr-agent-darwin-amd64
de7e065ef2cf6877b3b2cd04679a67b627f876337f529247e236204543e4062c  gbr-agent-darwin-arm64
a50a5c41993e6531a3b477eb409ccc845212bf541384dc803061c80657f86719  gbr-agent-linux-amd64
5bfd22c7110234942c4c02ff8154b836d0af45a9422c178a4f52010187d40061  gbr-agent-linux-arm64
f773b89fd31310172b756e0593e0f3b2382b0a3440af2a7d0a8b3073b0c23e27  gbr-agent-windows-amd64.exe
8fb9efcbc7e2ac91c11964944bf0f45e31bb23f4356d9dcb4b305d7cb9b0fe8c  gbr-agent-windows-arm64.exe
```

```bash
VER=v0.6.0
BASE=https://github.com/LinespottingOrg/GrokBuildRemote-Agents/releases/download/$VER
# swap darwin-arm64 for your OS/arch
curl -fsSL -o gbr-agent-darwin-arm64 "$BASE/gbr-agent-darwin-arm64"
curl -fsSL -o SHA256SUMS "$BASE/SHA256SUMS"
shasum -a 256 -c SHA256SUMS --ignore-missing
gbr-agent pair && gbr-agent run
```


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

MCP OAuth tokens are stored in `~/.kimi/mcp-oauth/`. After upgrading from older versions that used FastMCP 2.x, the old token cache is not migrated automatically; if `kimi mcp list` shows that an OAuth server needs authorization, run `kimi mcp auth <name>` again.

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

## Loading status

MCP servers initialize asynchronously after the shell UI starts, so the interface is usable immediately. The shell status bar shows live connection progress, automatically switching to a ready state once all servers are connected. The web interface also reflects each server's connection status in real time.

If multiple MCP servers are configured, loading may take a moment. The status bar progress indicator keeps you informed while connections are being established.

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
In YOLO or AFK mode, MCP tool calls will also be automatically approved. Use these modes only when you fully trust the MCP servers.
:::


## Build Remote Agent (phone pairing)

Pair a phone running [Build Remote Agent](https://grokbuildremote.com/) to this Kimi Code CLI session. Protocol `gbr/1`. Phone is spectator + veto, not orchestrator.

Independent product by Linespotting AB. Not affiliated with xAI or SpaceX.


Add the local stdio MCP server (loopback only). Never put mailbox keys in MCP config.

```sh
kimi mcp add --transport stdio gbr -- node /path/to/GrokBuildRemote-Agents/mcp/gbr-mcp/bin/gbr-mcp.js
```

Attach the Bot API directly:

```sh
curl -sS http://127.0.0.1:8788/health
curl -sS http://127.0.0.1:8788/v1/sessions
```

Phone: Build Remote Agent → scan the QR from `gbr-agent pair` (or type the 8-char code). Unpair in Settings before changing PCs.

## What the phone sees

**Terminal windows** on this PC (machine-wide mailbox). Not headless OpenCode / CodeNomad sidecar / Electron. `:8788` in a sidecar is Bot API JSON, not a transcript.

https://github.com/LinespottingOrg/GrokBuildRemote-Agents/blob/main/docs/WHAT-THE-PHONE-SEES.md
https://grokbuildremote.com/integrations.html

# Model Context Protocol

## What is MCP

::: info Reference Code
`src/kimi_cli/mcp.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/acp/mcp.py`, `src/kimi_cli/tools/`
:::

## `kimi mcp` subcommands

::: info Reference Code
`src/kimi_cli/mcp.py`, `src/kimi_cli/cli.py`
:::

## MCP config files

- `~/.kimi/mcp.json`
- `--mcp-config-file`
- `--mcp-config`

::: info Reference Code
`src/kimi_cli/mcp.py`, `src/kimi_cli/share.py`, `src/kimi_cli/cli.py`
:::

## Security

- Approval requests
- Tool prompt injection risks

::: info Reference Code
`src/kimi_cli/soul/approval.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/tools/utils.py`, `src/kimi_cli/tools/file/`, `src/kimi_cli/ui/shell/visualize.py`
:::

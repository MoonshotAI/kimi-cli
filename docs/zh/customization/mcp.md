# Model Context Protocol

## MCP 是什么

::: info 参考代码
`src/kimi_cli/mcp.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/acp/mcp.py`, `src/kimi_cli/tools/`
:::

## `kimi mcp` 子命令

::: info 参考代码
`src/kimi_cli/mcp.py`, `src/kimi_cli/cli.py`
:::

## MCP 配置文件

- `~/.kimi/mcp.json`
- `--mcp-config-file`
- `--mcp-config`

::: info 参考代码
`src/kimi_cli/mcp.py`, `src/kimi_cli/share.py`, `src/kimi_cli/cli.py`
:::

## 安全性

- 审批请求
- 工具提示词注入风险

::: info 参考代码
`src/kimi_cli/soul/approval.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/tools/utils.py`, `src/kimi_cli/tools/file/`, `src/kimi_cli/ui/shell/visualize.py`
:::

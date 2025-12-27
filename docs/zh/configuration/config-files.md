# 配置文件

## 配置文件位置

- `~/.kimi/config.toml`

::: info 参考代码
`src/kimi_cli/config.py`, `src/kimi_cli/share.py`, `README.md`
:::

## 配置项

- providers
- models
- loop control
- services
- MCP client

::: info 参考代码
`src/kimi_cli/config.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/mcp.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/tools/web/`
:::

## JSON 支持与迁移

- `config.json` 迁移
- `--config`/`--config-file` 仍可以用 JSON

::: info 参考代码
`src/kimi_cli/config.py`, `src/kimi_cli/cli.py`
:::

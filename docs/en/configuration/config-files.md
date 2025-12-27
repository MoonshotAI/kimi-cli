# Config Files

## Config file location

- `~/.kimi/config.toml`

::: info Reference Code
`src/kimi_cli/config.py`, `src/kimi_cli/share.py`, `README.md`
:::

## Config items

- providers
- models
- loop control
- services
- MCP client

::: info Reference Code
`src/kimi_cli/config.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/mcp.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/tools/web/`
:::

## JSON support and migration

- `config.json` migration
- `--config`/`--config-file` still accept JSON

::: info Reference Code
`src/kimi_cli/config.py`, `src/kimi_cli/cli.py`
:::

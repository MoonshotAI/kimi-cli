# Data Locations

## Config and metadata

- `~/.kimi/config.toml`
- `~/.kimi/kimi.json`
- `~/.kimi/mcp.json`

::: info Reference Code
`src/kimi_cli/share.py`, `src/kimi_cli/metadata.py`, `src/kimi_cli/config.py`, `src/kimi_cli/mcp.py`
:::

## Session data

- `~/.kimi/sessions/.../context.jsonl`
- `~/.kimi/sessions/.../wire.jsonl`

::: info Reference Code
`src/kimi_cli/session.py`, `src/kimi_cli/wire/serde.py`, `src/kimi_cli/soul/context.py`, `src/kimi_cli/wire/message.py`
:::

## Input history

- `~/.kimi/user-history/...`

::: info Reference Code
`src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/share.py`
:::

## Logs

- `~/.kimi/logs/kimi.log`

::: info Reference Code
`src/kimi_cli/utils/logging.py`, `src/kimi_cli/app.py`, `src/kimi_cli/share.py`
:::

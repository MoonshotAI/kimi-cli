# 数据路径

## 配置与元数据

- `~/.kimi/config.toml`
- `~/.kimi/kimi.json`
- `~/.kimi/mcp.json`

::: info 参考代码
`src/kimi_cli/share.py`, `src/kimi_cli/metadata.py`, `src/kimi_cli/config.py`, `src/kimi_cli/mcp.py`
:::

## 会话数据

- `~/.kimi/sessions/.../context.jsonl`
- `~/.kimi/sessions/.../wire.jsonl`

::: info 参考代码
`src/kimi_cli/session.py`, `src/kimi_cli/wire/serde.py`, `src/kimi_cli/soul/context.py`, `src/kimi_cli/wire/message.py`
:::

## 输入历史

- `~/.kimi/user-history/...`

::: info 参考代码
`src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/share.py`
:::

## 日志

- `~/.kimi/logs/kimi.log`

::: info 参考代码
`src/kimi_cli/utils/logging.py`, `src/kimi_cli/app.py`, `src/kimi_cli/share.py`
:::

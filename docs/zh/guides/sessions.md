# 会话与上下文

## 会话续接

- `--continue`、`--session`、`/sessions`
- 启动回放

::: info 参考代码
`src/kimi_cli/session.py`, `src/kimi_cli/metadata.py`, `src/kimi_cli/ui/shell/replay.py`, `src/kimi_cli/share.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/wire/serde.py`
:::

## 清空与压缩

- `/clear`（别名 `/reset`）
- `/compact`

::: info 参考代码
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/compaction.py`, `src/kimi_cli/soul/context.py`
:::

# 斜杠命令

## 帮助与信息

- `/help`、`/version`、`/release-notes`、`/feedback`

::: info 参考代码
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/utils/changelog.py`
:::

## 配置与调试

- `/setup`、`/reload`、`/debug`、`/usage`

::: info 参考代码
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/ui/shell/debug.py`, `src/kimi_cli/ui/shell/setup.py`, `src/kimi_cli/ui/shell/usage.py`
:::

## 会话管理

- `/clear`（别名 `/reset`）
- `/sessions`（别名 `/resume`）

::: info 参考代码
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/session.py`, `src/kimi_cli/soul/context.py`
:::

## 其他

- `/mcp`、`/init`、`/compact`、`/yolo`

::: info 参考代码
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/mcp.py`, `src/kimi_cli/soul/compaction.py`, `src/kimi_cli/soul/approval.py`
:::

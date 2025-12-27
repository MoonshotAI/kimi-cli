# Slash Commands

## Help and info

- `/help`, `/version`, `/release-notes`, `/feedback`

::: info Reference Code
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/utils/changelog.py`
:::

## Config and debug

- `/setup`, `/reload`, `/debug`, `/usage`

::: info Reference Code
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/ui/shell/debug.py`, `src/kimi_cli/ui/shell/setup.py`, `src/kimi_cli/ui/shell/usage.py`
:::

## Session management

- `/clear` (alias `/reset`)
- `/sessions` (alias `/resume`)

::: info Reference Code
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/session.py`, `src/kimi_cli/soul/context.py`
:::

## Others

- `/mcp`, `/init`, `/compact`, `/yolo`

::: info Reference Code
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/mcp.py`, `src/kimi_cli/soul/compaction.py`, `src/kimi_cli/soul/approval.py`
:::

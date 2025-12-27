# Interaction and Input

## Agent vs shell mode

- Ctrl-X to toggle mode
- Shell mode runs local commands

::: info Reference Code
`src/kimi_cli/ui/shell/__init__.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/utils/environment.py`, `src/kimi_cli/tools/shell/powershell.md`
:::

## Thinking mode

- Tab or `--thinking` to toggle
- Requires model support

::: info Reference Code
`src/kimi_cli/llm.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/cli.py`
:::

## Multi-line input

- Ctrl-J or Alt-Enter

::: info Reference Code
`src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/ui/shell/keyboard.py`
:::

## Clipboard and image paste

- Ctrl-V to paste
- Requires model support for `image_in`

::: info Reference Code
`src/kimi_cli/utils/clipboard.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/config.py`
:::

## Slash commands

::: info Reference Code
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/utils/slashcmd.py`
:::

## @ path completion

::: info Reference Code
`src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/utils/path.py`, `src/kimi_cli/tools/file/glob.py`
:::

## Approvals

- Once / This session / Reject
- `--yolo` or `/yolo`

::: info Reference Code
`src/kimi_cli/soul/approval.py`, `src/kimi_cli/ui/shell/visualize.py`, `src/kimi_cli/tools/file/write.py`, `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/ui/shell/slash.py`
:::

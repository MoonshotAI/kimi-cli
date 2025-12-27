# 交互与输入

## Agent 与 Shell 模式

- Ctrl-X 切换模式
- Shell 模式运行本地命令

::: info 参考代码
`src/kimi_cli/ui/shell/__init__.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/utils/environment.py`, `src/kimi_cli/tools/shell/powershell.md`
:::

## Thinking 模式

- Tab 或 `--thinking` 切换
- 需模型支持

::: info 参考代码
`src/kimi_cli/llm.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/cli.py`
:::

## 多行输入

- Ctrl-J 或 Alt-Enter

::: info 参考代码
`src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/ui/shell/keyboard.py`
:::

## 剪贴板与图片粘贴

- Ctrl-V 粘贴
- 需模型支持 `image_in`

::: info 参考代码
`src/kimi_cli/utils/clipboard.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/ui/shell/keyboard.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/config.py`
:::

## 斜杠命令

::: info 参考代码
`src/kimi_cli/ui/shell/slash.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/utils/slashcmd.py`
:::

## @ 路径补全

::: info 参考代码
`src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/utils/path.py`, `src/kimi_cli/tools/file/glob.py`
:::

## 审批与确认

- 一次 / 本会话 / 拒绝
- `--yolo` 或 `/yolo`

::: info 参考代码
`src/kimi_cli/soul/approval.py`, `src/kimi_cli/ui/shell/visualize.py`, `src/kimi_cli/tools/file/write.py`, `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/cli.py`, `src/kimi_cli/ui/shell/slash.py`
:::

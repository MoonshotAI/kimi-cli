# 内置工具

## 默认启用工具

- `Task`、`SetTodoList`、`Shell`、`ReadFile`、`Glob`、`Grep`、`WriteFile`、`StrReplaceFile`、`SearchWeb`、`FetchURL`

::: info 参考代码
`src/kimi_cli/agents/default/agent.yaml`, `src/kimi_cli/tools/`, `src/kimi_cli/tools/utils.py`
:::

## 可选工具

- `Think`、`SendDMail`、`CreateSubagent`
- 需在 Agent 文件中启用

::: info 参考代码
`src/kimi_cli/agents/default/sub.yaml`, `src/kimi_cli/tools/`, `src/kimi_cli/tools/think/`, `src/kimi_cli/tools/dmail/`, `src/kimi_cli/tools/multiagent/create.py`, `src/kimi_cli/agents/default/agent.yaml`, `src/kimi_cli/agentspec.py`
:::

## 工具安全边界与审批

- 工作目录限制
- diff 预览

::: info 参考代码
`src/kimi_cli/soul/approval.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/tools/file/`, `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/utils/path.py`, `src/kimi_cli/tools/file/write.py`, `src/kimi_cli/tools/file/diff_utils.py`, `src/kimi_cli/ui/shell/visualize.py`
:::

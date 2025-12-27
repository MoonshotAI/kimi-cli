# Built-in Tools

## Default tools

- `Task`, `SetTodoList`, `Shell`, `ReadFile`, `Glob`, `Grep`, `WriteFile`, `StrReplaceFile`, `SearchWeb`, `FetchURL`

::: info Reference Code
`src/kimi_cli/agents/default/agent.yaml`, `src/kimi_cli/tools/`, `src/kimi_cli/tools/utils.py`
:::

## Optional tools

- `Think`, `SendDMail`, `CreateSubagent`
- Must be enabled in Agent file

::: info Reference Code
`src/kimi_cli/agents/default/sub.yaml`, `src/kimi_cli/tools/`, `src/kimi_cli/tools/think/`, `src/kimi_cli/tools/dmail/`, `src/kimi_cli/tools/multiagent/create.py`, `src/kimi_cli/agents/default/agent.yaml`, `src/kimi_cli/agentspec.py`
:::

## Tool security and approvals

- Working directory restrictions
- Diff preview

::: info Reference Code
`src/kimi_cli/soul/approval.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/tools/file/`, `src/kimi_cli/tools/shell/__init__.py`, `src/kimi_cli/utils/path.py`, `src/kimi_cli/tools/file/write.py`, `src/kimi_cli/tools/file/diff_utils.py`, `src/kimi_cli/ui/shell/visualize.py`
:::

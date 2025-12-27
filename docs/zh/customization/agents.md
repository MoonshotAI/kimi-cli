# Agent 与子 Agent

## 内置 Agent

- `default`
- `okabe`

::: info 参考代码
`src/kimi_cli/agents/`, `src/kimi_cli/agentspec.py`, `src/kimi_cli/agents/default/agent.yaml`, `src/kimi_cli/agents/okabe/agent.yaml`
:::

## 自定义 Agent 文件

- YAML 格式
- `extend` 与 `exclude_tools`

::: info 参考代码
`src/kimi_cli/agentspec.py`, `src/kimi_cli/soul/agent.py`, `src/kimi_cli/agents/`, `src/kimi_cli/soul/toolset.py`
:::

## 系统提示词内置参数

- `KIMI_NOW`
- `KIMI_WORK_DIR`
- `KIMI_WORK_DIR_LS`
- `KIMI_AGENTS_MD`
- `KIMI_SKILLS`

::: info 参考代码
`src/kimi_cli/soul/agent.py`, `src/kimi_cli/tools/file/read.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/skill.py`, `src/kimi_cli/utils/datetime.py`, `src/kimi_cli/utils/path.py`
:::

## 在 Agent 文件中定义子 Agent

::: info 参考代码
`src/kimi_cli/agents/default/sub.yaml`, `src/kimi_cli/agentspec.py`
:::

## 动态子 Agent 与任务调度

- `CreateSubagent` 工具

::: info 参考代码
`src/kimi_cli/tools/multiagent/task.py`, `src/kimi_cli/tools/multiagent/create.py`, `src/kimi_cli/soul/agent.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/agents/default/sub.yaml`
:::

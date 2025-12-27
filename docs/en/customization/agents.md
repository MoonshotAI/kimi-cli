# Agents and Subagents

## Built-in agents

- `default`
- `okabe`

::: info Reference Code
`src/kimi_cli/agents/`, `src/kimi_cli/agentspec.py`, `src/kimi_cli/agents/default/agent.yaml`, `src/kimi_cli/agents/okabe/agent.yaml`
:::

## Custom agent file

- YAML format
- `extend` and `exclude_tools`

::: info Reference Code
`src/kimi_cli/agentspec.py`, `src/kimi_cli/soul/agent.py`, `src/kimi_cli/agents/`, `src/kimi_cli/soul/toolset.py`
:::

## System prompt built-in parameters

- `KIMI_NOW`
- `KIMI_WORK_DIR`
- `KIMI_WORK_DIR_LS`
- `KIMI_AGENTS_MD`
- `KIMI_SKILLS`

::: info Reference Code
`src/kimi_cli/soul/agent.py`, `src/kimi_cli/tools/file/read.py`, `src/kimi_cli/soul/slash.py`, `src/kimi_cli/skill.py`, `src/kimi_cli/utils/datetime.py`, `src/kimi_cli/utils/path.py`
:::

## Define subagents in agent file

::: info Reference Code
`src/kimi_cli/agents/default/sub.yaml`, `src/kimi_cli/agentspec.py`
:::

## Dynamic subagents and task scheduling

- `CreateSubagent` tool

::: info Reference Code
`src/kimi_cli/tools/multiagent/task.py`, `src/kimi_cli/tools/multiagent/create.py`, `src/kimi_cli/soul/agent.py`, `src/kimi_cli/soul/toolset.py`, `src/kimi_cli/agents/default/sub.yaml`
:::

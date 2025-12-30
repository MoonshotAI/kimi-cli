# Agent 与子 Agent

Agent 定义了 AI 的行为方式，包括系统提示词、可用工具和子 Agent。你可以使用内置 Agent，也可以创建自定义 Agent。

## 内置 Agent

Kimi CLI 提供两个内置 Agent：

- **default**：默认 Agent，适合通用的软件开发任务
- **okabe**：实验性 Agent，具有不同的提示词风格

启动时可以通过 `--agent` 参数选择：

```sh
kimi --agent okabe
```

## 自定义 Agent 文件

Agent 使用 YAML 格式定义。通过 `--agent-file` 参数加载自定义 Agent：

```sh
kimi --agent-file /path/to/my-agent.yaml
```

**基本结构**

```yaml
version: 1
agent:
  name: my-agent
  system_prompt_path: ./system.md
  tools:
    - "kimi_cli.tools.shell:Shell"
    - "kimi_cli.tools.file:ReadFile"
    - "kimi_cli.tools.file:WriteFile"
```

**继承与覆盖**

使用 `extend` 可以继承其他 Agent 的配置，只覆盖需要修改的部分：

```yaml
version: 1
agent:
  extend: default  # 继承默认 Agent
  system_prompt_path: ./my-prompt.md  # 覆盖系统提示词
  exclude_tools:  # 排除某些工具
    - "kimi_cli.tools.web:SearchWeb"
```

`extend: default` 会继承内置的默认 Agent。你也可以指定相对路径继承其他 Agent 文件。

**配置字段**

| 字段 | 说明 |
|------|------|
| `name` | Agent 名称 |
| `system_prompt_path` | 系统提示词文件路径（相对于 Agent 文件） |
| `system_prompt_args` | 传递给系统提示词的参数 |
| `tools` | 工具列表，格式为 `模块:类名` |
| `exclude_tools` | 要排除的工具（继承时使用） |
| `subagents` | 子 Agent 定义 |

## 系统提示词内置参数

系统提示词文件是一个 Markdown 模板，可以使用以下内置变量：

| 变量 | 说明 |
|------|------|
| `{KIMI_NOW}` | 当前时间 |
| `{KIMI_WORK_DIR}` | 工作目录路径 |
| `{KIMI_WORK_DIR_LS}` | 工作目录文件列表 |
| `{KIMI_AGENTS_MD}` | AGENTS.md 文件内容（如果存在） |
| `{KIMI_SKILLS}` | 加载的 Skills 信息 |

你也可以通过 `system_prompt_args` 定义自定义参数：

```yaml
agent:
  system_prompt_args:
    MY_VAR: "自定义值"
```

然后在提示词中使用 `{MY_VAR}`。

## 在 Agent 文件中定义子 Agent

子 Agent 可以处理特定类型的任务。在 Agent 文件中定义：

```yaml
version: 1
agent:
  extend: default
  subagents:
    coder:
      path: ./coder-sub.yaml
      description: "处理编码任务"
    reviewer:
      path: ./reviewer-sub.yaml
      description: "代码审查专家"
```

子 Agent 文件也是标准的 Agent 格式，通常会继承主 Agent 并排除某些工具：

```yaml
# coder-sub.yaml
version: 1
agent:
  extend: ./agent.yaml  # 继承主 Agent
  system_prompt_args:
    ROLE_ADDITIONAL: |
      你现在作为子 Agent 运行...
  exclude_tools:
    - "kimi_cli.tools.multiagent:Task"  # 子 Agent 不能再创建任务
```

## 动态子 Agent 与任务调度

主 Agent 可以使用 `Task` 工具动态创建子 Agent 来处理复杂任务。这种方式下，子 Agent 会在独立的上下文中运行，完成后将结果返回给主 Agent。

任务调度的优势：

- 隔离上下文，避免污染主 Agent 的对话历史
- 并行处理多个独立任务
- 专门的子 Agent 可以有针对性的提示词

`CreateSubagent` 是一个高级工具，允许在运行时动态创建新的子 Agent 类型（默认未启用）。如需使用，在 Agent 文件中添加：

```yaml
agent:
  tools:
    - "kimi_cli.tools.multiagent:CreateSubagent"
```

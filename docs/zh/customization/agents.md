# Agent 与子 Agent

Agent 定义了 AI 的行为方式，包括系统提示词、可用工具和子 Agent。你可以使用内置 Agent，也可以创建自定义 Agent。

## 内置 Agent

Kimi CLI 提供两个内置 Agent。启动时可以通过 `--agent` 参数选择：

```sh
kimi --agent okabe
```

### `default`

默认 Agent，适合通常情况使用。启用的工具：

`Task`、`SetTodoList`、`Shell`、`ReadFile`、`Glob`、`Grep`、`WriteFile`、`StrReplaceFile`、`SearchWeb`、`FetchURL`

### `okabe`

实验性 Agent，用于实验新的提示词和工具。在 `default` 的基础上额外启用 `SendDMail`。

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
    - "kimi_cli.tools.web:FetchURL"
```

`extend: default` 会继承内置的默认 Agent。你也可以指定相对路径继承其他 Agent 文件。

**配置字段**

| 字段 | 说明 | 是否必填 |
|------|------|----------|
| `extend` | 继承的 Agent，可以是 `default` 或相对路径 | 否 |
| `name` | Agent 名称 | 是（继承时可省略） |
| `system_prompt_path` | 系统提示词文件路径，相对于 Agent 文件 | 是（继承时可省略） |
| `system_prompt_args` | 传递给系统提示词的自定义参数，继承时会合并 | 否 |
| `tools` | 工具列表，格式为 `模块:类名` | 是（继承时可省略） |
| `exclude_tools` | 要排除的工具 | 否 |
| `subagents` | 子 Agent 定义 | 否 |

## 系统提示词内置参数

系统提示词文件是一个 Markdown 模板，可以使用 `${VAR}` 语法引用变量。内置变量包括：

| 变量 | 说明 |
|------|------|
| `${KIMI_NOW}` | 当前时间（ISO 格式） |
| `${KIMI_WORK_DIR}` | 工作目录路径 |
| `${KIMI_WORK_DIR_LS}` | 工作目录文件列表 |
| `${KIMI_AGENTS_MD}` | AGENTS.md 文件内容（如果存在） |
| `${KIMI_SKILLS}` | 加载的 Skills 列表 |

你也可以通过 `system_prompt_args` 定义自定义参数：

```yaml
agent:
  system_prompt_args:
    MY_VAR: "自定义值"
```

然后在提示词中使用 `${MY_VAR}`。

**系统提示词示例**

```markdown
# My Agent

You are a helpful assistant. Current time: ${KIMI_NOW}.

Working directory: ${KIMI_WORK_DIR}

${MY_VAR}
```

## 在 Agent 文件中定义子 Agent

子 Agent 可以处理特定类型的任务。在 Agent 文件中定义子 Agent 后，主 Agent 可以通过 `Task` 工具启动它们：

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
    - "kimi_cli.tools.multiagent:Task"  # 排除 Task 工具，避免嵌套
```

## 子 Agent 的运行方式

通过 `Task` 工具启动的子 Agent 会在独立的上下文中运行，完成后将结果返回给主 Agent。这种方式的优势：

- 隔离上下文，避免污染主 Agent 的对话历史
- 可以并行处理多个独立任务
- 子 Agent 可以有针对性的系统提示词

## 动态创建子 Agent

`CreateSubagent` 是一个高级工具，允许 AI 在运行时动态定义新的子 Agent 类型（默认未启用）。如需使用，在 Agent 文件中添加：

```yaml
agent:
  tools:
    - "kimi_cli.tools.multiagent:CreateSubagent"
```

## 内置工具列表

以下是 Kimi CLI 内置的所有工具。

### `Task`

- **路径**：`kimi_cli.tools.multiagent:Task`
- **描述**：调度子 Agent 执行任务。子 Agent 无法访问主 Agent 的上下文，需在 prompt 中提供所有必要信息。

| 参数 | 类型 | 说明 |
|------|------|------|
| `description` | string | 任务简短描述（3-5 词） |
| `subagent_name` | string | 子 Agent 名称 |
| `prompt` | string | 任务详细描述 |

### `SetTodoList`

- **路径**：`kimi_cli.tools.todo:SetTodoList`
- **描述**：管理待办事项列表，跟踪任务进度

| 参数 | 类型 | 说明 |
|------|------|------|
| `todos` | array | 待办事项列表 |
| `todos[].title` | string | 待办事项标题 |
| `todos[].status` | string | 状态：`pending`、`in_progress`、`done` |

### `Shell`

- **路径**：`kimi_cli.tools.shell:Shell`
- **描述**：执行 Shell 命令。需要用户审批。根据操作系统使用对应的 Shell（Unix 使用 bash/zsh，Windows 使用 PowerShell）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `command` | string | 要执行的命令 |
| `timeout` | int | 超时时间（秒），默认 60，最大 300 |

### `ReadFile`

- **路径**：`kimi_cli.tools.file:ReadFile`
- **描述**：读取文件内容。支持文本、图片和视频文件。文本文件单次最多读取 1000 行，每行最多 2000 字符；图片/视频文件最大 80MB。工作目录外的文件需使用绝对路径。

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 文件路径 |
| `line_offset` | int | 起始行号，默认 1（仅适用于文本文件） |
| `n_lines` | int | 读取行数，默认/最大 1000（仅适用于文本文件） |

### `Glob`

- **路径**：`kimi_cli.tools.file:Glob`
- **描述**：按模式匹配文件和目录。最多返回 1000 个匹配项，不允许以 `**` 开头的模式。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pattern` | string | Glob 模式（如 `*.py`、`src/**/*.ts`） |
| `directory` | string | 搜索目录，默认工作目录 |
| `include_dirs` | bool | 是否包含目录，默认 true |

### `Grep`

- **路径**：`kimi_cli.tools.file:Grep`
- **描述**：使用正则表达式搜索文件内容，基于 ripgrep 实现

| 参数 | 类型 | 说明 |
|------|------|------|
| `pattern` | string | 正则表达式模式 |
| `path` | string | 搜索路径，默认当前目录 |
| `glob` | string | 文件过滤（如 `*.js`） |
| `type` | string | 文件类型（如 `py`、`js`、`go`） |
| `output_mode` | string | 输出模式：`files_with_matches`（默认）、`content`、`count_matches` |
| `-B` | int | 显示匹配行前 N 行 |
| `-A` | int | 显示匹配行后 N 行 |
| `-C` | int | 显示匹配行前后 N 行 |
| `-n` | bool | 显示行号 |
| `-i` | bool | 忽略大小写 |
| `multiline` | bool | 启用多行匹配 |
| `head_limit` | int | 限制输出行数 |

### `WriteFile`

- **路径**：`kimi_cli.tools.file:WriteFile`
- **描述**：写入文件。写入操作需要用户审批。写入工作目录外文件时，必须使用绝对路径。

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 绝对路径 |
| `content` | string | 文件内容 |
| `mode` | string | `overwrite`（默认）或 `append` |

### `StrReplaceFile`

- **路径**：`kimi_cli.tools.file:StrReplaceFile`
- **描述**：使用字符串替换编辑文件。编辑操作需要用户审批。编辑工作目录外文件时，必须使用绝对路径。

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 绝对路径 |
| `edit` | object/array | 单个编辑或编辑列表 |
| `edit.old` | string | 要替换的原字符串 |
| `edit.new` | string | 替换后的字符串 |
| `edit.replace_all` | bool | 是否替换所有匹配项，默认 false |

### `SearchWeb`

- **路径**：`kimi_cli.tools.web:SearchWeb`
- **描述**：搜索网页。需要配置搜索服务（Kimi Code 平台自动配置）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | string | 搜索关键词 |
| `limit` | int | 结果数量，默认 5，最大 20 |
| `include_content` | bool | 是否包含页面内容，默认 false |

### `FetchURL`

- **路径**：`kimi_cli.tools.web:FetchURL`
- **描述**：抓取网页内容，返回提取的主要文本内容。如果配置了抓取服务会优先使用，否则使用本地 HTTP 请求。

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | string | 要抓取的 URL |

### `Think`

- **路径**：`kimi_cli.tools.think:Think`
- **描述**：让 Agent 记录思考过程，适用于复杂推理场景

| 参数 | 类型 | 说明 |
|------|------|------|
| `thought` | string | 思考内容 |

### `SendDMail`

- **路径**：`kimi_cli.tools.dmail:SendDMail`
- **描述**：发送延迟消息（D-Mail），用于检查点回滚场景

| 参数 | 类型 | 说明 |
|------|------|------|
| `message` | string | 要发送的消息 |
| `checkpoint_id` | int | 要发送回的检查点 ID（>= 0） |

### `CreateSubagent`

- **路径**：`kimi_cli.tools.multiagent:CreateSubagent`
- **描述**：动态创建子 Agent

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | string | 子 Agent 的唯一名称，用于在 `Task` 工具中引用 |
| `system_prompt` | string | 定义 Agent 角色、能力和边界的系统提示词 |

## 工具安全边界

**工作目录限制**

- 文件读写通常在工作目录内进行
- 读取工作目录外文件需使用绝对路径
- 写入和编辑操作都需要用户审批；操作工作目录外文件时，必须使用绝对路径

**审批机制**

以下操作需要用户审批：

| 操作 | 审批要求 |
|------|---------|
| Shell 命令执行 | 每次执行 |
| 文件写入/编辑 | 每次操作 |
| MCP 工具调用 | 每次调用 |

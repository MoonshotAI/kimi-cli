# Agent 与子 Agent

Agent 定义了 AI 的行为方式，包括系统提示词、可用工具和子 Agent。你可以使用内置 Agent，也可以创建自定义 Agent。

## 内置 Agent

Kimi Code CLI 提供两个内置 Agent。启动时可以通过 `--agent` 参数选择：

```sh
kimi --agent okabe
```

### `default`

默认 Agent，适合通常情况使用。启用的工具：

`Agent`、`AskUserQuestion`、`SetTodoList`、`Shell`、`ReadFile`、`ReadMediaFile`、`Glob`、`Grep`、`WriteFile`、`StrReplaceFile`、`SearchWeb`、`FetchURL`、`EnterPlanMode`、`ExitPlanMode`、`TaskList`、`TaskOutput`、`TaskStop`

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

系统提示词文件是一个 Markdown 模板，可以使用 `${VAR}` 语法引用变量，也支持 Jinja2 的 `{% include %}` 指令来引入其他文件。内置变量包括：

| 变量 | 说明 |
|------|------|
| `${KIMI_NOW}` | 当前时间（ISO 格式） |
| `${KIMI_WORK_DIR}` | 工作目录路径 |
| `${KIMI_WORK_DIR_LS}` | 工作目录文件列表 |
| `${KIMI_AGENTS_MD}` | 从项目根目录到工作目录逐层合并的 `AGENTS.md` 内容（包括 `.kimi/AGENTS.md`） |
| `${KIMI_SKILLS}` | 加载的 Skills 列表 |
| `${KIMI_ADDITIONAL_DIRS_INFO}` | 通过 `--add-dir` 或 `/add-dir` 添加的额外目录信息 |

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

子 Agent 可以处理特定类型的任务。在 Agent 文件中定义子 Agent 后，主 Agent 可以通过 `Agent` 工具启动它们：

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

子 Agent 文件也是标准的 Agent 格式，通常会继承主 Agent：

```yaml
# coder-sub.yaml
version: 1
agent:
  extend: ./agent.yaml  # 继承主 Agent
  system_prompt_args:
    ROLE_ADDITIONAL: |
      你现在作为子 Agent 运行...
```

## 内置子 Agent 类型

默认 Agent 配置包含三种内置子 Agent 类型，各自有不同的工具策略和适用场景：

| 类型 | 用途 | 可用工具 |
|------|------|---------|
| `coder` | 通用软件工程：读写文件、运行命令、搜索代码 | `Shell`、`ReadFile`、`ReadMediaFile`、`Glob`、`Grep`、`WriteFile`、`StrReplaceFile`、`SearchWeb`、`FetchURL` |
| `explore` | 快速只读代码探索：搜索、阅读、总结 | `Shell`、`ReadFile`、`ReadMediaFile`、`Glob`、`Grep`、`SearchWeb`、`FetchURL`（无写入工具） |
| `plan` | 实现规划与架构设计：分析文件、制定方案 | `ReadFile`、`ReadMediaFile`、`Glob`、`Grep`、`SearchWeb`、`FetchURL`（无 Shell、无写入工具） |

所有子 Agent 类型均不可嵌套使用 `Agent` 工具（即子 Agent 不能创建自己的子 Agent）。`Agent` 工具仅在根 Agent 中可用。

## 子 Agent 的运行方式

通过 `Agent` 工具启动的子 Agent 会在独立的上下文中运行，完成后将结果返回给主 Agent。每个子 Agent 实例在会话目录的 `subagents/<agent_id>/` 下维护独立的上下文历史和元数据，可以被多次恢复继续使用。这种方式的优势：

- 隔离上下文，避免污染主 Agent 的对话历史
- 可以并行处理多个独立任务
- 子 Agent 可以有针对性的系统提示词
- 持久实例可跨多次调用保留上下文

## 内置工具列表

以下是 Kimi Code CLI 内置的所有工具。

### `Agent`

- **路径**：`kimi_cli.tools.agent:Agent`
- **描述**：启动或恢复子 Agent 实例处理聚焦任务。内置三种子 Agent 类型：`coder`（通用软件工程）、`explore`（快速只读代码探索）、`plan`（实现规划与架构设计）。每个实例维护独立的上下文历史，支持前台或后台运行。

| 参数 | 类型 | 说明 |
|------|------|------|
| `description` | string | 任务简短描述（3-5 词） |
| `prompt` | string | 任务详细描述 |
| `subagent_type` | string | 内置子 Agent 类型，默认 `coder` |
| `model` | string | 可选的模型覆盖 |
| `resume` | string | 可选的 Agent 实例 ID，用于恢复现有实例 |
| `run_in_background` | bool | 是否在后台运行，默认 false |
| `timeout` | int | 超时时间（秒），范围 30–3600。前台默认无超时（运行到完成），后台默认 15 分钟；超时后任务会被停止 |

### `AskUserQuestion`

- **路径**：`kimi_cli.tools.ask_user:AskUserQuestion`
- **描述**：在执行过程中向用户展示结构化问题和选项，收集用户偏好或决策。适用于需要用户在多个方案中做出选择、解决模糊指令或收集需求信息的场景。不应过度使用——只在用户的选择真正影响后续操作时才调用。

| 参数 | 类型 | 说明 |
|------|------|------|
| `questions` | array | 问题列表（1–4 个问题） |
| `questions[].question` | string | 问题文本，以 `?` 结尾 |
| `questions[].header` | string | 短标签，最多 12 字符（如 `Auth`、`Style`） |
| `questions[].options` | array | 可选项（2–4 个），系统会自动添加 "Other" 选项 |
| `questions[].options[].label` | string | 选项标签（1–5 词），推荐选项可追加 `(Recommended)` |
| `questions[].options[].description` | string | 选项说明 |
| `questions[].multi_select` | bool | 是否允许多选，默认 false |

### `SetTodoList`

- **路径**：`kimi_cli.tools.todo:SetTodoList`
- **描述**：管理待办事项列表，跟踪任务进度。支持三种使用模式：更新模式（传入 `todos` 数组替换整个列表）、查询模式（省略 `todos` 参数返回当前列表）和清空模式（传入空数组 `[]` 清空列表）。待办事项会持久化到会话状态。

| 参数 | 类型 | 说明 |
|------|------|------|
| `todos` | array \| null | 待办事项列表。省略时查询当前列表；传入 `[]` 清空列表 |
| `todos[].title` | string | 待办事项标题 |
| `todos[].status` | string | 状态：`pending`、`in_progress`、`done` |

### `Shell`

- **路径**：`kimi_cli.tools.shell:Shell`
- **描述**：执行 Shell 命令。需要用户审批。根据操作系统使用对应的 Shell（Unix 使用 bash/zsh，Windows 使用 PowerShell）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `command` | string | 要执行的命令 |
| `timeout` | int | 超时时间（秒），默认 60，前台最大 300 / 后台最大 86400 |
| `run_in_background` | bool | 是否作为后台任务运行，默认 false |
| `description` | string | 后台任务的简短描述，`run_in_background=true` 时必填 |

设置 `run_in_background=true` 后，命令会作为后台任务启动，工具立即返回任务 ID，AI 可以继续执行其他操作。任务完成时系统自动发送通知。适用于耗时的构建、测试、监控等场景。

### `ReadFile`

- **路径**：`kimi_cli.tools.file:ReadFile`
- **描述**：读取文本文件内容。单次最多读取 1000 行，每行最多 2000 字符。工作目录外的文件需使用绝对路径。每次读取都会在消息中返回文件总行数。敏感文件（如 `.env`、SSH 私钥、云凭据）会被拒绝读取。

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 文件路径 |
| `line_offset` | int | 起始行号，默认 1。支持负数表示从文件末尾读取（如 `-100` 读取最后 100 行），绝对值不超过 1000 |
| `n_lines` | int | 读取行数，默认/最大 1000 |

### `ReadMediaFile`

- **路径**：`kimi_cli.tools.file:ReadMediaFile`
- **描述**：读取图片或视频文件。文件最大 100MB。仅当模型支持图片/视频输入时可用。工作目录外的文件需使用绝对路径。

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 文件路径 |

### `Glob`

- **路径**：`kimi_cli.tools.file:Glob`
- **描述**：按模式匹配文件和目录。最多返回 1000 个匹配项，不允许以 `**` 开头的模式。支持搜索已发现的 Skill 根目录，路径中的 `~` 会自动展开为用户主目录。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pattern` | string | Glob 模式（如 `*.py`、`src/**/*.ts`） |
| `directory` | string | 搜索目录，默认工作目录 |
| `include_dirs` | bool | 是否包含目录，默认 true |

### `Grep`

- **路径**：`kimi_cli.tools.file:Grep`
- **描述**：使用正则表达式搜索文件内容，基于 ripgrep 实现。默认搜索隐藏文件（dotfiles），但不搜索被 `.gitignore` 排除的文件。敏感文件（如 `.env`、SSH 私钥、云凭据）始终被过滤，即使设置了 `include_ignored` 也不会出现在结果中。

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
| `-n` | bool | 显示行号，默认 true |
| `-i` | bool | 忽略大小写 |
| `multiline` | bool | 启用多行匹配 |
| `head_limit` | int | 限制输出行数，默认 250 |
| `offset` | int | 跳过前 N 条结果，用于分页，默认 0 |
| `include_ignored` | bool | 搜索被 `.gitignore` 排除的文件（如 `node_modules`、构建产物），默认 false |

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

### `EnterPlanMode`

- **路径**：`kimi_cli.tools.plan.enter:EnterPlanMode`
- **描述**：请求进入 Plan 模式。调用后通常会向用户展示审批请求；如果会话处于 YOLO 或 AFK 模式则会自动批准进入。YOLO 只自动批准进入 Plan 模式，`ExitPlanMode` 仍会把最终方案展示给用户审批。仅在用户明确要求规划或存在重大架构歧义时使用。详见 [Plan 模式](../guides/interaction.md#plan-模式)。

此工具不接受参数。

### `ExitPlanMode`

- **路径**：`kimi_cli.tools.plan:ExitPlanMode`
- **描述**：在 Plan 模式下完成方案后提交审批。调用前需先将方案写入 plan 文件，此工具会读取 plan 文件内容并展示给用户审批。用户可以选择某个实施路径（退出 Plan 模式并开始执行）、拒绝（保持 Plan 模式等待反馈）或提供修改意见。详见 [Plan 模式](../guides/interaction.md#plan-模式)。

| 参数 | 类型 | 说明 |
|------|------|------|
| `options` | list \| null | 当方案包含多个可选实施路径时，列出 2–3 个选项供用户选择。每个选项有 `label`（1–8 个词的简短标签，可附加 "(Recommended)"）和可选的 `description`（方案摘要）。不可使用 "Approve"、"Reject"、"Revise" 作为标签名。 |

### `TaskList`

- **路径**：`kimi_cli.tools.background:TaskList`
- **描述**：列出当前会话中的后台任务。适用于上下文压缩后重新获取任务 ID，或检查哪些任务仍在运行。

| 参数 | 类型 | 说明 |
|------|------|------|
| `active_only` | bool | 是否仅列出活跃任务，默认 true |
| `limit` | int | 返回的最大任务数（1–100），默认 20 |

### `TaskOutput`

- **路径**：`kimi_cli.tools.background:TaskOutput`
- **描述**：获取后台任务的输出和状态。默认为非阻塞查询，返回当前状态和输出快照；如果输出被截断，可使用 `ReadFile` 分页读取完整日志。

| 参数 | 类型 | 说明 |
|------|------|------|
| `task_id` | string | 要查询的任务 ID |
| `block` | bool | 是否等待任务完成，默认 false |
| `timeout` | int | `block=true` 时的最大等待秒数（0–3600），默认 30 |

### `TaskStop`

- **路径**：`kimi_cli.tools.background:TaskStop`
- **描述**：停止正在运行的后台任务。需要用户审批。仅在任务必须取消时使用；对于正常完成的任务，应等待自动通知。在 Plan 模式下不可用。

| 参数 | 类型 | 说明 |
|------|------|------|
| `task_id` | string | 要停止的任务 ID |
| `reason` | string | 停止原因（可选），默认 "Stopped by TaskStop" |


## 工具安全边界

**工作区范围**

- 文件读写通常在工作目录（及通过 `--add-dir` 或 `/add-dir` 添加的额外目录）内进行
- 读取工作区外文件需使用绝对路径
- 写入和编辑操作都需要用户审批；操作工作区外文件时，必须使用绝对路径

**审批机制**

以下操作需要用户审批：

| 操作 | 审批要求 |
|------|---------|
| Shell 命令执行 | 每次执行 |
| 文件写入/编辑 | 每次操作 |
| MCP 工具调用 | 每次调用 |
| 停止后台任务 | 每次停止 |

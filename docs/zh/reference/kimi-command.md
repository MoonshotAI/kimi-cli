# `kimi` 命令

`kimi` 是 Kimi CLI 的主命令，用于启动交互式会话或执行单次查询。

```sh
kimi [OPTIONS] COMMAND [ARGS]
```

## 基本信息

| 选项 | 简写 | 说明 |
|------|------|------|
| `--version` | `-V` | 显示版本号并退出 |
| `--help` | `-h` | 显示帮助信息并退出 |
| `--verbose` | | 输出详细运行信息 |
| `--debug` | | 记录调试日志（输出到 `~/.kimi/logs/kimi.log`） |

## Agent 配置

| 选项 | 说明 |
|------|------|
| `--agent NAME` | 使用内置 Agent，可选值：`default`、`okabe` |
| `--agent-file PATH` | 使用自定义 Agent 文件 |

`--agent` 和 `--agent-file` 互斥，不能同时使用。详见 [Agent 与子 Agent](../customization/agents.md)。

## 配置文件

| 选项 | 说明 |
|------|------|
| `--config STRING` | 加载 TOML/JSON 配置字符串 |
| `--config-file PATH` | 加载配置文件（默认 `~/.kimi/config.toml`） |

`--config` 和 `--config-file` 互斥。配置字符串和文件均支持 TOML 和 JSON 格式。详见 [配置文件](../configuration/config-files.md)。

## 模型选择

| 选项 | 简写 | 说明 |
|------|------|------|
| `--model NAME` | `-m` | 指定 LLM 模型，覆盖配置文件中的默认模型 |

## 工作目录

| 选项 | 简写 | 说明 |
|------|------|------|
| `--work-dir PATH` | `-w` | 指定工作目录（默认当前目录） |

工作目录决定了文件操作的根目录，Agent 只能在此目录内读写文件。

## 会话管理

| 选项 | 简写 | 说明 |
|------|------|------|
| `--continue` | `-C` | 继续当前工作目录的上一个会话 |
| `--session ID` | `-S` | 恢复指定 ID 的会话，若不存在则创建新会话 |

`--continue` 和 `--session` 互斥。

## 输入与命令

| 选项 | 简写 | 说明 |
|------|------|------|
| `--prompt TEXT` | `-p` | 传入用户提示，不进入交互模式 |
| `--command TEXT` | `-c` | `--prompt` 的别名 |

使用 `--prompt`（或 `--command`）时，Kimi CLI 会处理完查询后退出（除非指定 `--print`，否则仍以交互模式显示结果）。

## 循环控制

| 选项 | 说明 |
|------|------|
| `--max-steps-per-turn N` | 单轮最大步数，覆盖配置文件中的 `loop_control.max_steps_per_turn` |
| `--max-retries-per-step N` | 单步最大重试次数，覆盖配置文件中的 `loop_control.max_retries_per_step` |
| `--max-ralph-iterations N` | Ralph 循环模式的迭代次数；`0` 表示关闭；`-1` 表示无限 |

### Ralph 循环

[Ralph](https://ghuntley.com/ralph/) 是一种把 Agent 放进循环的技术：同一条提示词会被反复喂给 Agent，让它围绕一个任务持续迭代。

当 `--max-ralph-iterations` 非 `0` 时，Kimi CLI 会进入 Ralph 循环模式，基于内置的 Prompt Flow 自动循环执行任务，直到 Agent 输出 `<choice>STOP</choice>` 或达到迭代上限。

::: info 注意
Ralph 循环与 `--prompt-flow` 选项互斥，不能同时使用。
:::

## 提示词流

| 选项 | 说明 |
|------|------|
| `--prompt-flow PATH` | 加载 Mermaid 流程图文件作为 Prompt Flow |

Prompt Flow 是一种基于 Mermaid 流程图的工作流描述方式，每个节点对应一次对话轮次。加载后，可以通过 `/begin` 命令启动流程执行。

流程图示例（`example.mmd` 文件）：

```
flowchart TD
    A([BEGIN]) --> B[分析现有代码，为 XXX 功能编写设计文档，写在 design.md 文件中]
    B --> C{Review 一遍 design.md，看看是否足够详细}
    C -->|是| D[开始实现]
    C -->|否| B
    D --> F([END])
```

```mermaid
flowchart TD
    A([BEGIN]) --> B[分析现有代码，为 XXX 功能编写设计文档，写在 design.md 文件中]
    B --> C{Review 一遍 design.md，看看是否足够详细}
    C -->|是| D[开始实现]
    C -->|否| B
    D --> F([END])
```

在节点处理过程中，分支节点（`{}`）会要求 Agent 输出 `<choice>分支名</choice>` 来选择下一个节点。

::: info 注意
`--prompt-flow` 与 Ralph 循环模式互斥，不能同时使用。
:::

## UI 模式

| 选项 | 说明 |
|------|------|
| `--print` | 以 Print 模式运行（非交互式），隐式启用 `--yolo` |
| `--quiet` | `--print --output-format text --final-message-only` 的快捷方式 |
| `--acp` | 以 ACP 服务器模式运行（已弃用，请使用 `kimi acp`） |
| `--wire` | 以 Wire 服务器模式运行（实验性） |

四个选项互斥，只能选择一个。默认使用 Shell 模式。详见 [Print 模式](../customization/print-mode.md) 和 [Wire 模式](../customization/wire-mode.md)。

## Print 模式选项

以下选项仅在 `--print` 模式下有效：

| 选项 | 说明 |
|------|------|
| `--input-format FORMAT` | 输入格式：`text`（默认）或 `stream-json` |
| `--output-format FORMAT` | 输出格式：`text`（默认）或 `stream-json` |
| `--final-message-only` | 仅输出最终的 assistant 消息 |

`stream-json` 格式使用 JSONL（每行一个 JSON 对象），用于程序化集成。

## MCP 配置

| 选项 | 说明 |
|------|------|
| `--mcp-config-file PATH` | 加载 MCP 配置文件，可多次指定 |
| `--mcp-config JSON` | 加载 MCP 配置 JSON 字符串，可多次指定 |

默认加载 `~/.kimi/mcp.json`（如果存在）。详见 [Model Context Protocol](../customization/mcp.md)。

## 审批控制

| 选项 | 简写 | 说明 |
|------|------|------|
| `--yolo` | `-y` | 自动批准所有操作 |
| `--yes` | | `--yolo` 的别名 |
| `--auto-approve` | | `--yolo` 的别名 |

::: warning 注意
YOLO 模式下，所有文件修改和 Shell 命令都会自动执行，请谨慎使用。
:::

## Thinking 模式

| 选项 | 说明 |
|------|------|
| `--thinking` | 启用 thinking 模式 |
| `--no-thinking` | 禁用 thinking 模式 |

Thinking 模式需要模型支持。如果不指定，使用上次会话的设置。

## Skills 配置

| 选项 | 说明 |
|------|------|
| `--skills-dir PATH` | 指定 skills 目录（默认 `~/.kimi/skills`） |

详见 [Agent Skills](../customization/skills.md)。

## 子命令

| 子命令 | 说明 |
|--------|------|
| [`kimi info`](./kimi-info.md) | 显示版本和协议信息 |
| [`kimi acp`](./kimi-acp.md) | 启动多会话 ACP 服务器 |
| [`kimi mcp`](./kimi-mcp.md) | 管理 MCP 服务器配置 |
| [`kimi term`](./kimi-term.md) | 启动 Toad 终端 UI |

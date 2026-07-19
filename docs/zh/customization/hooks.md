# Hooks (Beta)

::: warning Beta 功能
Hooks 系统目前处于 Beta 阶段，具体的实现细节和配置定义可能会在未来版本中调整。请谨慎在生产环境中使用，并关注后续更新。
:::

Hooks 系统让你可以在 Agent 生命周期的关键节点执行自定义命令，实现自动化工作流、安全检查、通知提醒等功能。

## Hook 是什么

Hook 是一种在特定事件发生时触发的机制。你可以配置一个 shell 命令，当事件发生时，Kimi Code CLI 会将事件相关的上下文信息通过标准输入传递给该命令，并根据命令的退出码决定后续行为。

使用场景示例：

- **代码格式化**：在文件编辑后自动运行 `prettier` 或 `black`
- **安全检查**：阻止危险的 shell 命令（如 `rm -rf /`）
- **敏感文件保护**：防止修改 `.env` 等配置文件
- **桌面通知**：在需要人工审批时发送通知
- **任务验证**：在会话结束前检查是否有未完成的任务

## 支持的 Hook 事件

Kimi Code CLI 支持 14 种生命周期事件：

| 事件 | 触发时机 | Matcher 过滤 | 可用上下文 |
|------|----------|--------------|------------|
| `PreToolUse` | 工具调用前 | 工具名称 | `tool_name`, `tool_input`, `tool_call_id` |
| `PostToolUse` | 工具成功执行后 | 工具名称 | `tool_name`, `tool_input`, `tool_output` |
| `PostToolUseFailure` | 工具执行失败后 | 工具名称 | `tool_name`, `tool_input`, `error` |
| `UserPromptSubmit` | 用户提交输入前 | 无 | `prompt` |
| `Stop` | Agent 轮次结束时 | 无 | `stop_hook_active` |
| `StopFailure` | 轮次因错误结束时 | 错误类型 | `error_type`, `error_message` |
| `SessionStart` | 会话创建/恢复时 | 来源 (`startup`/`resume`) | `source` |
| `SessionEnd` | 会话关闭时 | 原因 | `reason` |
| `SubagentStart` | 子 Agent 启动时 | Agent 名称 | `agent_name`, `prompt` |
| `SubagentStop` | 子 Agent 结束时 | Agent 名称 | `agent_name`, `response` |
| `PreCompact` | 上下文压缩前 | 触发原因 | `trigger`, `token_count` |
| `PostCompact` | 上下文压缩后 | 触发原因 | `trigger`, `estimated_token_count` |
| `Notification` | 通知发送到 sink 时 | sink 名称 | `sink`, `notification_type`, `title`, `body`, `severity` |
| `MessageDisplay` | 助手回复流式输出时重复触发 | 无 | `message_id`, `displayed_text`, `is_final` |

### MessageDisplay（流式回复期间触发）

`MessageDisplay` 在助手回复流式输出过程中重复触发——而 `Stop` 仅在轮次结束时触发一次。适用于实时播报、增量日志，或任何希望在回复生成过程中（而非结束后）做出响应的消费方。这是一个 **fire-and-forget** 事件：hook 的输出与退出码会被忽略。

事件特有字段：

```json
{
  "message_id": "整条流式消息的稳定 id",
  "displayed_text": "该消息截至目前已流式输出的累积文本（非增量）",
  "is_final": "该消息最后一次触发时为 true，否则为 false"
}
```

`displayed_text` 是累积文本而非增量，因此 hook 脚本无需自行拼接分块——每次触发都携带截至目前已流式输出的累积文本。触发经过防抖（至多约每 200ms 一次），但最后一次触发（`is_final: true`）除外——消息结束时总会触发，回复的尾部不会因等待防抖窗口而丢失。

投递语义——hook 脚本可以依赖的保证：

- **较慢的 hook 会看到更少、更新的负载。** 每条消息最多只有一个进行中的流式 hook 执行；执行期间，更新的防抖负载会替换排队中的旧负载，而不会堆积在其后。由于每个负载都携带完整累积文本，因此不会丢失信息。
- **`is_final` 永远不会排在过期投递之后**，并且总是在 `Stop` hook 触发之前到达。轮次最多等待最终投递完成 5 秒；较慢的 hook 仍会先收到 `is_final`——只是对其完成的等待是有上限的。
- **取消会抑制 `is_final`。** 在最终负载触发前被取消的轮次不会触发它——请把"取消即静默"视为 flush/丢弃信号（例如超时兜底）。
- **在 `is_final` 之前，`displayed_text` 是临时的。** 请把中间负载视为显示状态，而非权威的最终内容。
- **使用工具的轮次会产生多条消息。** 每次模型调用都有自己的 `message_id` 和对应的 `is_final: true` 触发：工具调用前的文本是一条消息，工具结果之后的续写是另一条。不产生显示文本的模型调用（仅工具调用）不会触发任何事件。

`MessageDisplay` 在所有界面上都会触发（交互式 shell、print/headless、ACP、wire、web），且负载契约相同，因为它们共享同一条流式路径。

## 配置 Hooks

在 `~/.kimi/config.toml` 中使用 `[[hooks]]` 数组定义 hook：

```toml
# 文件编辑后自动格式化
[[hooks]]
event = "PostToolUse"
matcher = "WriteFile|StrReplaceFile"
command = "jq -r '.tool_input.file_path' | xargs prettier --write"

# 阻止修改 .env 文件
[[hooks]]
event = "PreToolUse"
matcher = "WriteFile|StrReplaceFile"
command = ".kimi/hooks/protect-env.sh"
timeout = 10

# 需要审批时发送桌面通知
[[hooks]]
event = "Notification"
matcher = "permission_prompt"
command = "osascript -e 'display notification \"Kimi needs attention\" with title \"Kimi CLI\"'"

# 会话结束前检查任务完成情况
[[hooks]]
event = "Stop"
command = ".kimi/hooks/check-complete.sh"
```

### 配置字段

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `event` | 是 | — | 事件类型，必须是上述 14 种之一 |
| `command` | 是 | — | 要执行的 shell 命令，通过 stdin 接收 JSON 上下文 |
| `matcher` | 否 | `""` | 正则表达式过滤，空字符串匹配所有 |
| `timeout` | 否 | `30` | 超时时间（秒），超时后按 fail-open 处理 |

## 通信协议

### 输入（标准输入）

Hook 命令从标准输入接收 JSON 格式的上下文信息，包含通用字段和事件特定字段：

```json
{
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "hook_event_name": "PreToolUse",
  "tool_name": "Shell",
  "tool_input": {"command": "rm -rf /"}
}
```

### 输出（退出码）

| 退出码 | 行为 | 反馈 |
|--------|------|------|
| `0` | 允许继续 | 标准输出内容（非空时）会添加到上下文 |
| `2` | 阻止操作 | 标准错误内容会反馈给 LLM 作为修正建议 |
| 其他 | 允许继续 | 标准错误仅记录日志，不展示给 LLM |

### 结构化 JSON 输出

退出码 0 时，可以通过输出结构化 JSON 提供更详细的信息：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "请使用 rg 代替 grep"
  }
}
```

当 `permissionDecision` 为 `deny` 时，会阻止操作并将 `permissionDecisionReason` 反馈给 LLM。

## Hook 脚本示例

### 保护敏感文件

```bash
#!/bin/bash
# .kimi/hooks/protect-env.sh

read JSON
echo "$JSON" | jq -r '.tool_input.file_path' | grep -qE '\.env$|\.env\.local$'

if [ $? -eq 0 ]; then
    echo "Error: Direct modification of .env files is not allowed. Use .env.example instead." >&2
    exit 2
fi

exit 0
```

### 自动格式化代码

```bash
#!/bin/bash
# .kimi/hooks/auto-format.sh

FILE=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))")

if [[ "$FILE" == *.js ]] || [[ "$FILE" == *.ts ]]; then
    prettier --write "$FILE" 2>/dev/null
elif [[ "$FILE" == *.py ]]; then
    black "$FILE" 2>/dev/null
fi

exit 0
```

### 检查未完成的任务

```bash
#!/bin/bash
# .kimi/hooks/check-complete.sh

# 检查是否有进行中的后台任务
if kimi task list --active 2>/dev/null | grep -q "running"; then
    echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"还有后台任务在运行，请先检查 /task"}}'
    exit 0
fi

exit 0
```

## 查看已配置的 Hooks

在 Shell 模式下使用 `/hooks` 命令查看当前配置的 hooks：

```
/hooks
```

输出示例：

```
Configured Hooks:

  PostToolUse: 1 hook(s)
  PreToolUse: 1 hook(s)
  Notification: 1 hook(s)
  Stop: 1 hook(s)
```

## 设计原则

### Fail-Open 策略

所有 hook 执行失败（超时、崩溃、正则表达式错误）都按 "允许" 处理，确保不会阻塞 Agent 的正常工作。你可以通过日志查看 hook 执行失败的原因。

### 并行执行

同一事件的多个 hook 会并行执行，提高性能。相同的命令会自动去重。

### Stop Hook 防循环

Stop hook 最多只能重新触发一次，防止无限循环。重新触发时，`stop_hook_active` 字段会设为 `true`，hook 可以根据此标志提前退出。

### 上下文变量

Session ID 通过 ContextVar 传递，避免在每次工具调用时显式传递参数。

## 与插件的区别

| 特性 | Hooks | 插件 |
|------|-------|------|
| 触发方式 | 生命周期事件驱动 | 工具调用驱动 |
| 执行时机 | 特定事件发生时 | AI 主动调用 |
| 交互方式 | 无交互，接收 stdin | 接收 JSON 参数 |
| 用途 | 自动化、安全检查、通知 | 扩展 AI 能力 |
| 返回值 | 退出码控制流程 | 标准输出作为结果 |

Hooks 适合在关键节点执行检查或自动化任务，而插件适合为 AI 提供新的工具能力。两者可以结合使用，例如通过 hook 阻止某些操作，通过插件提供替代方案。

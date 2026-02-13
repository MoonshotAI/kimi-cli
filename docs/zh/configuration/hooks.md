# Hooks 配置

Hooks 允许你在 Kimi Code CLI 的生命周期中插入自定义逻辑，用于安全检查、代码审查、自动化流程等。

## 概述

Kimi Code CLI 支持三种类型的 hooks：

1. **Command** - 执行外部命令或脚本
2. **Prompt** - 使用 LLM 进行智能决策
3. **Agent** - 启动子 Agent 进行复杂验证

## 配置位置

Hooks 配置在 `~/.kimi/config.toml` 中的 `[hooks]` 部分：

```toml
[hooks]
# 在会话开始时执行
session_start = [
    { type = "command", name = "notify-start", command = "notify-send 'Kimi session started'" }
]

# 在工具执行前拦截
before_tool = [
    { type = "prompt", name = "security-check", matcher = { tool = "Shell" }, prompt = "..." }
]
```

## Hook 类型

### Command Hooks

执行 shell 命令，接收事件信息作为 JSON 输入：

```toml
[[hooks.before_tool]]
name = "custom-validator"
type = "command"
matcher = { tool = "Shell" }
command = "python /path/to/validator.py"
timeout = 30000  # 毫秒
```

命令的退出码含义：
- `0` - 成功，解析 stdout 作为结果
- `2` - 阻断错误（系统阻断）
- 其他 - 非阻断错误（警告）

输出格式（JSON）：
```json
{
    "decision": "allow" | "deny" | "ask",
    "reason": "说明",
    "additional_context": "额外信息"
}
```

### Prompt Hooks

使用 LLM 对事件进行智能分析：

```toml
[[hooks.before_tool]]
name = "ai-security-check"
type = "prompt"
matcher = { tool = "Shell" }
prompt = """
判断以下 Shell 命令是否安全：
命令: {{tool_input.command}}

如果命令可能破坏数据或系统，返回：
{"decision": "deny", "reason": "原因"}

否则返回：
{"decision": "allow"}
"""
temperature = 0.1  # 控制随机性
```

配置项：
- `prompt` - 提示词模板，支持 `{{变量}}` 语法
- `system_prompt` - 可选的系统提示词覆盖
- `model` - 使用的模型（默认使用会话模型）
- `temperature` - 采样温度（0.0-2.0，默认 0.1）

可用的模板变量取决于事件类型：
- `event_type` - 事件类型
- `session_id` - 会话 ID
- `work_dir` - 工作目录
- `tool_input` - 工具输入（工具事件）
- `tool_name` - 工具名称（工具事件）

### Agent Hooks

启动子 Agent 执行复杂验证任务：

```toml
[[hooks.after_tool]]
name = "test-analyzer"
type = "agent"
matcher = { tool = "Shell", pattern = "pytest" }
task = """
分析测试结果，如果有失败的测试：
1. 找出失败原因
2. 提供修复建议
3. 返回简洁的总结

上下文：
事件类型: {{event_type}}
工具输出: {{tool_output}}
"""
timeout = 120000  # 2分钟
```

配置项：
- `task` - 子 Agent 的任务描述
- `agent_file` - 可选的自定义 Agent 配置文件
- `timeout` - 超时时间（毫秒，默认 2 分钟）

## 事件类型

| 事件类型 | 触发时机 | 可用变量 |
|---------|---------|---------|
| `session_start` | 会话开始时 | `model`, `args` |
| `session_end` | 会话结束时 | `duration_seconds`, `total_steps`, `exit_reason` |
| `before_agent` | Agent 执行前 | - |
| `after_agent` | Agent 执行后 | - |
| `before_tool` | 工具执行前 | `tool_name`, `tool_input`, `tool_use_id` |
| `after_tool` | 工具执行后 | `tool_name`, `tool_input`, `tool_output` |
| `after_tool_failure` | 工具执行失败时 | `tool_name`, `tool_input`, `error` |
| `subagent_start` | 子 Agent 启动时 | `subagent_name`, `subagent_type`, `task_description` |
| `subagent_stop` | 子 Agent 停止时 | `subagent_name`, `exit_reason` |
| `pre_compact` | 上下文压缩前 | `context_tokens` |

## Matcher 配置

使用 matcher 过滤 hook 执行：

```toml
# 匹配特定工具
matcher = { tool = "Shell" }

# 使用正则匹配工具名
matcher = { tool = "Read.*" }

# 匹配参数内容
matcher = { pattern = "rm -rf /" }

# 组合匹配
matcher = { tool = "Shell", pattern = "dangerous_command" }
```

## 调试 Hooks

使用 `--debug-hooks` 参数启用详细日志：

```bash
kimi --debug-hooks
```

日志内容包括：
- 每个 hook 的触发事件
- 执行耗时
- 决策结果和原因
- 错误信息

日志保存在 `~/.kimi/logs/kimi.log`。

## 示例

### Git 提交前检查

```toml
[[hooks.before_tool]]
name = "pre-commit-check"
type = "command"
matcher = { tool = "Shell", pattern = "git commit" }
command = "pre-commit run --files $(git diff --cached --name-only)"
```

### 代码格式化

```toml
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black {{tool_input.path}}"
async = true  # 异步执行，不阻塞
```

### 危险命令确认

```toml
[[hooks.before_tool]]
name = "dangerous-command-check"
type = "prompt"
matcher = { tool = "Shell", pattern = "rm|drop|delete" }
prompt = """
分析以下命令是否存在风险：
{{tool_input.command}}

如果是危险操作（如删除重要文件、清空数据库等），返回：
{"decision": "ask", "reason": "可能的危险操作说明"}

否则返回：
{"decision": "allow"}
"""
```

### 敏感信息检测

```toml
[[hooks.before_tool]]
name = "secret-detection"
type = "prompt"
matcher = { tool = "WriteFile" }
prompt = """
检查以下内容是否包含敏感信息（API 密钥、密码、私钥等）：

文件路径: {{tool_input.path}}
内容预览: {{tool_input.content[:500]}}

如果包含敏感信息，返回：
{"decision": "deny", "reason": "检测到敏感信息：xxx"}

否则返回：
{"decision": "allow"}
"""
```

### 测试自动分析

```toml
[[hooks.after_tool]]
name = "test-analysis"
type = "agent"
matcher = { tool = "Shell", pattern = "pytest|unittest" }
task = """
分析测试结果并提供反馈：

命令输出：
{{tool_output}}

请：
1. 统计通过/失败的测试数量
2. 如果有失败，分析失败原因
3. 提供修复建议

返回格式：
{"decision": "allow", "additional_context": "你的分析"}
"""
```

## 最佳实践

1. **设置合理的超时**：避免 hook 阻塞主流程太久
2. **使用异步执行**：对于非关键操作，使用 `async = true`
3. **编写清晰的提示词**：Prompt hooks 的效果取决于提示词质量
4. **逐步启用**：先在测试环境验证 hooks 再应用到生产
5. **记录决策原因**：有助于后续审计和调试

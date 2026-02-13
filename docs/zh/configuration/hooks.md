# Hooks 配置

Hooks 允许你在 Kimi Code CLI 的生命周期中插入自定义命令，用于安全检查、代码审查、自动化流程等。

## 概述

Kimi Code CLI 的 hooks 采用**命令式**设计：通过执行外部命令或脚本来实现自定义逻辑。这种方式：

- **简单透明**：没有隐藏的 LLM 调用
- **完全可控**：你决定用什么语言/工具实现逻辑
- **易于调试**：标准输入输出，易于测试

## 配置位置

Hooks 配置在 `~/.kimi/config.toml` 中的 `[hooks]` 部分：

```toml
[hooks]
# 在会话开始时执行
[[hooks.session_start]]
name = "notify-start"
type = "command"
command = "notify-send 'Kimi session started'"

# 在工具执行前拦截
[[hooks.before_tool]]
name = "block-dangerous"
type = "command"
matcher = { tool = "Shell", pattern = "rm -rf /" }
command = "echo '{\"decision\": \"deny\", \"reason\": \"Dangerous command\"}'"
```

## Hook 配置

### 基本结构

```toml
[[hooks.EVENT_TYPE]]
name = "hook-name"              # 可选，用于识别
command = "shell command"       # 要执行的命令
timeout = 30000                 # 超时时间（毫秒，默认 30s）
matcher = { ... }               # 可选，过滤条件
async_ = false                  # 是否异步执行（默认 false）
description = "Description"     # 可选描述
```

### Matcher 过滤

使用 matcher 只在特定条件下执行 hook：

```toml
# 匹配特定工具
matcher = { tool = "Shell" }

# 使用正则匹配工具名
matcher = { tool = "Read.*|Write.*" }

# 匹配参数内容
matcher = { pattern = "rm -rf" }

# 组合匹配
matcher = { tool = "Shell", pattern = "rm -rf /" }
```

### 异步执行

设置 `async_ = true` 让 hook 在后台执行，不阻塞主流程：

```toml
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet \"$KIMI_WORK_DIR/{{tool_input.file_path}}\""
async_ = true  # 异步执行
timeout = 30000
```

## 命令协议

### 输入

命令通过 **stdin** 接收 JSON 格式的事件信息：

```json
{
  "event_type": "before_tool",
  "timestamp": "2026-01-15T10:30:00+08:00",
  "session_id": "sess_abc123",
  "work_dir": "/home/user/project",
  "tool_name": "Shell",
  "tool_input": {
    "command": "ls -la"
  }
}
```

### 输出

命令通过 **stdout** 返回 JSON 结果：

```json
{
  "decision": "allow",        // allow | deny | ask
  "reason": "说明",
  "additional_context": "额外信息"
}
```

### 退出码

| 退出码 | 含义 | 行为 |
|--------|------|------|
| `0` | 成功 | 解析 stdout 作为结果 |
| `2` | 阻断错误 | 阻断动作，stderr 作为反馈 |
| 其他 | 非阻断错误 | 记录警告，继续执行 |

## 环境变量

Hook 命令可以访问以下环境变量：

- `KIMI_SESSION_ID` - 当前会话 ID
- `KIMI_WORK_DIR` - 当前工作目录
- `KIMI_PROJECT_DIR` - 同 WORK_DIR
- `KIMI_ENV_FILE` - 环境变量文件路径（用于 session_start hooks 传递变量）

## 事件类型

| 事件类型 | 触发时机 | stdin 额外字段 |
|---------|---------|---------------|
| `session_start` | 会话开始时 | - |
| `session_end` | 会话结束时 | `duration_seconds`, `total_steps`, `exit_reason` |
| `before_agent` | Agent 执行前 | - |
| `after_agent` | Agent 执行后 | - |
| `before_tool` | 工具执行前 | `tool_name`, `tool_input`, `tool_use_id` |
| `after_tool` | 工具执行后 | `tool_name`, `tool_input`, `tool_output` |
| `after_tool_failure` | 工具执行失败时 | `tool_name`, `tool_input`, `error` |
| `subagent_start` | 子 Agent 启动时 | `subagent_name`, `subagent_type`, `task_description` |
| `subagent_stop` | 子 Agent 停止时 | `subagent_name`, `exit_reason` |
| `pre_compact` | 上下文压缩前 | `context_tokens` |

## 示例

### Python Hook 脚本

```python
#!/usr/bin/env python3
# my-security-hook.py
import json
import sys

def main():
    # 读取事件数据
    event = json.load(sys.stdin)
    
    tool_name = event.get("tool_name", "")
    tool_input = event.get("tool_input", {})
    
    # 安全检查逻辑
    if tool_name == "Shell":
        command = tool_input.get("command", "")
        dangerous = ["rm -rf /", "mkfs", "dd if=/dev/zero"]
        if any(d in command for d in dangerous):
            result = {
                "decision": "deny",
                "reason": f"Dangerous command detected: {command}"
            }
            print(json.dumps(result))
            sys.exit(2)  # 阻断
    
    # 默认允许
    result = {"decision": "allow"}
    print(json.dumps(result))

if __name__ == "__main__":
    main()
```

配置使用：

```toml
[[hooks.before_tool]]
name = "security-check"
type = "command"
matcher = { tool = "Shell" }
command = "python /path/to/my-security-hook.py"
```

### Shell Hook 示例

```toml
# 危险命令拦截
[[hooks.before_tool]]
name = "block-dangerous"
type = "command"
matcher = { tool = "Shell", pattern = "rm -rf /|mkfs" }
command = """
echo '{"decision": "deny", "reason": "Dangerous command blocked"}'
exit 2
"""

# Git 信息注入
[[hooks.session_start]]
name = "inject-git-info"
type = "command"
command = """
branch=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "{\"additional_context\": \"Current branch: $branch\"}"
"""

# 代码自动格式化（异步）
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet \"$KIMI_WORK_DIR/{{tool_input.file_path}}\" 2>/dev/null || true"
async_ = true
```

## 调试

使用 `--debug-hooks` 参数查看详细的 hook 执行日志：

```bash
kimi --debug-hooks
```

日志输出包括：
- Hook 触发事件
- 输入上下文
- 执行结果和耗时
- 错误信息

## 最佳实践

1. **保持简单**：单个 hook 只做一件事
2. **快速执行**：设置合理的超时时间
3. **Fail Open**：错误时不要阻断主流程（除非确实需要）
4. **使用异步**：对于非关键操作（如格式化、通知）使用 `async_ = true`
5. **记录日志**：hook 脚本自己记录日志便于调试

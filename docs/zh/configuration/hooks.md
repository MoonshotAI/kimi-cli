# Hooks 配置

Hooks 允许你在 Kimi Code CLI 的生命周期中插入自定义命令，用于安全检查、代码审查、自动化流程等。

## 概述

Kimi Code CLI 的 hooks 采用**命令式**设计：通过执行外部命令或脚本来实现自定义逻辑。这种方式：

- **简单透明**：没有隐藏的 LLM 调用
- **完全可控**：你决定用什么语言/工具实现逻辑
- **易于调试**：标准输入输出，易于测试
- **同步/异步可选**：默认同步（可阻断），可选异步（不阻塞）

## 配置位置

Hooks 配置在 `~/.kimi/config.toml` 中的 `[hooks]` 部分：

```toml
[hooks]
# 在会话开始时执行
[[hooks.session_start]]
name = "notify-start"
type = "command"
command = "notify-send 'Kimi session started'"

# 在工具执行前拦截（同步执行，可阻断）
[[hooks.before_tool]]
name = "block-dangerous"
type = "command"
matcher = { tool = "Shell", pattern = "rm -rf /" }
command = "echo '{\"decision\": \"deny\", \"reason\": \"Dangerous command\"}'"

# 在文件写入后异步执行（不阻塞）
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet ."
async_ = true  # 异步执行
```

## Hook 配置

### 基本结构

```toml
[[hooks.EVENT_TYPE]]
name = "hook-name"              # 可选，用于识别
type = "command"                # 目前仅支持 command
command = "shell command"       # 要执行的命令
timeout = 30000                 # 超时时间（毫秒，默认 30s）
matcher = { ... }               # 可选，过滤条件
async_ = false                  # 是否异步执行（默认 false）
description = "Description"     # 可选描述
```

### 执行模式：同步 vs 异步

#### 同步模式（默认）

```toml
[[hooks.before_tool]]
name = "security-check"
type = "command"
matcher = { tool = "Shell" }
command = "python /path/to/security-check.py"
async_ = false  # 或省略，默认同步
```

**特点：**
- 等待 hook 完成后再继续
- **可以阻断操作**（通过 `decision = "deny"` 或 exit code 2）
- 适用于安全检查、权限验证等关键操作
- 阻塞主流程，会影响响应速度

#### 异步模式

```toml
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet \"$KIMI_WORK_DIR/{{tool_input.file_path}}\""
async_ = true  # 异步执行
timeout = 30000
```

**特点：**
- 立即返回，不等待 hook 完成
- **无法阻断操作**（即使返回 deny 也无效）
- 适用于格式化、通知、日志等非关键操作
- 不阻塞主流程，性能更好

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

**`before_stop` 事件输入：**

```json
{
  "event_type": "before_stop",
  "timestamp": "2026-01-15T10:30:00+08:00",
  "session_id": "sess_abc123",
  "work_dir": "/home/user/project",
  "stop_reason": "no_tool_calls",
  "step_count": 5,
  "final_message": {
    "role": "assistant",
    "content": "我已完成任务..."
  }
}
```

| 字段 | 说明 |
|------|------|
| `stop_reason` | 停止原因：`no_tool_calls`（正常完成）或 `tool_rejected` |
| `step_count` | 本轮对话执行的步数 |
| `final_message` | Agent 的最终消息（如有） |

### 输出

命令通过 **stdout** 返回 JSON 结果：

```json
{
  "decision": "allow",        // allow | deny | ask
  "reason": "说明",
  "modified_input": {},       // 修改后的输入（可选）
  "additional_context": "额外信息"  // 附加上下文（可选）
}
```

### 退出码控制

| 退出码 | 含义 | 行为 | 适用模式 |
|--------|------|------|---------|
| `0` | 成功 | 解析 stdout JSON 作为结果 | 同步/异步 |
| `2` | 阻断错误 | 阻断动作，stderr 作为反馈 | **仅同步** |
| 其他 | 非阻断错误 | 记录警告，继续执行 | 同步/异步 |

**重要区别：**

- **同步模式**（`async_ = false`）：
  - Exit 0 + `{"decision": "deny"}` → **阻断操作**
  - Exit 2 → **阻断操作**，stderr 作为原因
  
- **异步模式**（`async_ = true`）：
  - 无论返回什么，都不会阻断操作
  - 仅用于记录和副作用

## 环境变量

Hook 命令可以访问以下环境变量：

- `KIMI_SESSION_ID` - 当前会话 ID
- `KIMI_WORK_DIR` - 当前工作目录
- `KIMI_PROJECT_DIR` - 同 WORK_DIR
- `KIMI_ENV_FILE` - 环境变量文件路径（用于 session_start hooks 传递变量）

## 事件类型与阻断能力

| 事件类型 | 触发时机 | 可阻断 | 建议模式 |
|---------|---------|--------|---------|
| `session_start` | 会话开始时 | ⚠️ 不建议 | 同步/异步 |
| `session_end` | 会话结束时 | ⚠️ 不建议 | 同步/异步 |
| `before_agent` | Agent 执行前 | ✅ 可以 | 同步 |
| `after_agent` | Agent 执行后 | ⚠️ 不建议 | 异步 |
| `before_tool` | 工具执行前 | ✅ **推荐** | **同步** |
| `after_tool` | 工具执行后 | ❌ 不可 | **异步** |
| `after_tool_failure` | 工具执行失败时 | ❌ 不可 | 异步 |
| `subagent_start` | 子 Agent 启动时 | ✅ 可以 | 同步 |
| `subagent_stop` | 子 Agent 停止时 | ✅ 可以 | 同步 |
| `pre_compact` | 上下文压缩前 | ⚠️ 不建议 | 异步 |
| `before_stop` | Agent 停止响应前 | ✅ **质量门禁** | **同步** |

## 示例

### 同步 Hook：危险命令拦截

```toml
[[hooks.before_tool]]
name = "block-dangerous"
type = "command"
matcher = { tool = "Shell", pattern = "rm -rf /|mkfs|dd if=/dev/zero" }
command = """
echo '{"decision": "deny", "reason": "Dangerous command blocked"}'
exit 2  # 使用 exit 2 强制阻断
"""
```

### 异步 Hook：代码自动格式化

```toml
[[hooks.after_tool]]
name = "auto-format-python"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet ."
async_ = true  # 异步执行，不阻塞编辑流程
timeout = 30000
```

### Python Hook 脚本

```python
#!/usr/bin/env python3
# security-hook.py
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
        
        # 危险命令列表
        dangerous = ["rm -rf /", "mkfs", "dd if=/dev/zero", "> /dev/sda"]
        for pattern in dangerous:
            if pattern in command:
                # 方法 1: 使用 exit 2 阻断
                print(f"Dangerous command detected: {pattern}", file=sys.stderr)
                sys.exit(2)
                
        # 需要确认的敏感操作
        if "prod" in command and ("drop" in command or "delete" in command):
            result = {
                "decision": "ask",
                "reason": "This affects production. Continue?"
            }
            print(json.dumps(result))
            sys.exit(0)
    
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
command = "python /path/to/security-hook.py"
timeout = 5000
```

### 质量门禁 Hook：在停止前强制执行标准

`before_stop` hook 在 Agent 即将停止响应时触发。用它来实现质量门禁：

```toml
[[hooks.before_stop]]
name = "verify-tests"
type = "command"
command = """
# 在允许 Agent 完成前运行测试
if ! npm test 2>&1; then
    echo "测试通过前不能完成任务" >&2
    exit 2
fi
echo '{"decision": "allow"}'
"""
timeout = 60000
```

当 `before_stop` hook 阻断时（exit 2 或 `decision = "deny"`），Agent 会继续工作，并将 hook 的反馈添加到上下文中：

```
[Hook blocked stop: 测试通过前不能完成任务]
```

更复杂的示例——检查多个条件：

```python
#!/usr/bin/env python3
# quality-gate.py
import json
import subprocess
import sys

def main():
    event = json.load(sys.stdin)
    
    # 检查测试是否通过
    test_result = subprocess.run(["npm", "test"], capture_output=True, text=True)
    if test_result.returncode != 0:
        print(json.dumps({
            "decision": "deny",
            "reason": "测试失败。修复后再完成。"
        }))
        sys.exit(0)
    
    # 检查代码格式
    fmt_result = subprocess.run(["black", "--check", "."], capture_output=True)
    if fmt_result.returncode != 0:
        print(json.dumps({
            "decision": "deny", 
            "reason": "代码未格式化。运行 'black .' 修复。"
        }))
        sys.exit(0)
    
    print(json.dumps({"decision": "allow"}))

if __name__ == "__main__":
    main()
```

### 组合使用：同步检查 + 异步处理

```toml
# 1. 同步拦截危险命令
[[hooks.before_tool]]
name = "block-dangerous"
type = "command"
matcher = { tool = "Shell" }
command = """
input=$(cat)
if echo "$input" | grep -q "rm -rf /"; then
    echo '{"decision": "deny", "reason": "Dangerous command blocked"}'
    exit 2
fi
echo '{"decision": "allow"}'
"""

# 2. 异步格式化代码
[[hooks.after_tool]]
name = "auto-format"
type = "command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "black --quiet ."
async_ = true
timeout = 30000

# 3. 异步发送通知
[[hooks.after_tool]]
name = "notify-changes"
type = "command"
matcher = { tool = "WriteFile" }
command = """
input=$(cat)
file=$(echo "$input" | grep -o '"file_path": "[^"]*"' | cut -d'"' -f4)
notify-send "File modified: $file"
"""
async_ = true
timeout = 5000
```

## 调试

使用 `--debug` 参数查看详细的 hook 执行日志（包含 hooks 调试）：

```bash
kimi --debug
```

日志输出包括：
- Hook 触发事件
- 同步/异步模式标识
- 输入上下文
- 执行结果和耗时
- 错误信息

示例输出：
```
[HOOK DEBUG] [SYNC] Starting command hook 'block-dangerous' for event 'before_tool'
[HOOK DEBUG] [SYNC] Completed hook 'block-dangerous' in 45ms: success=True, decision=deny
[HOOK DEBUG] Reason: Dangerous command blocked

[HOOK DEBUG] [ASYNC] Starting command hook 'auto-format' for event 'after_tool'
[HOOK DEBUG] [ASYNC] Hook 'auto-format' fired (running in background)
```

## 最佳实践

### 1. 根据场景选择模式

| 场景 | 推荐模式 | 原因 |
|------|---------|------|
| 安全检查、权限验证 | 同步 | 需要阻断能力 |
| 代码格式化 | 异步 | 不需要等待 |
| 日志记录 | 异步 | 不影响性能 |
| 通知推送 | 异步 | 即时反馈 |
| 数据备份 | 同步 | 确保执行完成 |

### 2. 设置合理的超时时间

```toml
# 快速检查：1秒
[[hooks.before_tool]]
name = "quick-check"
timeout = 1000
command = "..."

# 复杂分析：10秒
[[hooks.before_tool]]
name = "deep-analysis"
timeout = 10000
command = "..."

# 长时间任务：使用异步
[[hooks.after_tool]]
name = "long-task"
async_ = true
timeout = 60000
command = "..."
```

### 3. 使用 exit code 2 强制阻断

当需要确保操作被阻断时，使用 exit 2：

```bash
#!/bin/bash
# 这种方法最可靠，不依赖 JSON 解析

if [ "危险条件" ]; then
    echo "阻断原因" >&2
    exit 2
fi

echo '{"decision": "allow"}'
exit 0
```

### 4. Fail Open 原则

Hook 失败时（超时、异常、非 0/2 退出码），默认允许操作继续：

```python
# 你的 hook 代码应该处理异常，避免意外阻断
try:
    # 检查逻辑
    if is_dangerous():
        sys.exit(2)  # 明确阻断
except Exception as e:
    # 出错时记录日志但允许继续
    print(f"Hook error: {e}", file=sys.stderr)
    print('{"decision": "allow"}')
    sys.exit(0)
```

### 5. 异步 Hook 注意事项

- 异步 hook 无法修改输入参数
- 异步 hook 的 `decision: deny` 会被忽略
- 异步 hook 的 stdout 会记录到日志但不会阻断操作
- 使用异步 hook 进行副作用操作（格式化、通知、日志）

## 高级用法

### 条件执行

```toml
# 只在生产环境执行
[[hooks.before_tool]]
name = "prod-check"
type = "command"
matcher = { tool = "Shell" }
command = """
if [ "$ENV" = "production" ]; then
    python /path/to/prod-check.py
else
    echo '{"decision": "allow"}'
fi
"""
```

### 链式 Hooks

多个 hooks 会按配置顺序执行：

```toml
# Hook 1: 快速检查（可能阻断）
[[hooks.before_tool]]
name = "quick-check"
command = "..."

# Hook 2: 深度检查（仅在上一个未阻断时执行）
[[hooks.before_tool]]
name = "deep-check"
command = "..."

# Hook 3: 异步处理（总是执行）
[[hooks.after_tool]]
name = "async-process"
async_ = true
command = "..."
```

### 使用环境变量传递状态

```toml
[[hooks.session_start]]
name = "setup-env"
command = """
mkdir -p .kimi
echo "PROJECT_TYPE=python" >> .kimi/env
echo '{"decision": "allow"}'
"""

[[hooks.before_tool]]
name = "type-check"
command = """
if [ "$PROJECT_TYPE" = "python" ]; then
    # 执行 Python 特定检查
fi
"""
```

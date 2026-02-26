# Agent Hooks

Agent Hooks 是一个开放的、模块化的标准，用于在 Kimi Code CLI 的生命周期中插入自定义逻辑，用于安全检查、代码审查、自动化流程等。

## 概述

Agent Hooks 采用**模块化目录**设计：每个 hook 是一个包含配置和脚本的独立文件夹，代理可以在其生命周期的特定时间点自动发现并执行这些脚本。

**核心特点：**

- **开放标准**：一次编写，到处使用（跨代理平台兼容）
- **模块化**：每个 hook 独立管理，易于分享和复用
- **分层配置**：支持用户级别和项目级别钩子，自动合并
- **简单透明**：没有隐藏的 LLM 调用
- **完全可控**：你决定用什么语言/工具实现逻辑
- **同步/异步可选**：默认同步（可阻断），可选异步（不阻塞）

## 快速开始

### 目录结构

```tree
~/.config/agents/hooks/           # 用户级别 (XDG)
└── security-check/
    ├── HOOK.md                   # 钩子元数据和配置
    └── scripts/
        └── run.sh                # 可执行脚本

./my-project/.agents/hooks/       # 项目级别
└── project-specific/
    ├── HOOK.md
    └── scripts/
        └── run.sh
```

### HOOK.md 示例

```markdown
---
name: block-dangerous-commands
description: 阻止 rm -rf / 等危险的 shell 命令
trigger: before_tool
matcher:
  tool: Shell
  pattern: "rm -rf /|mkfs|dd if=/dev/zero"
timeout: 5000
async: false
priority: 999
---

# 阻止危险命令

此钩子阻止执行危险的系统命令。
```

### 脚本示例 (scripts/run.sh)

```bash
#!/bin/bash
# 从 stdin 读取事件数据
event_data=$(cat)

# 检查危险命令
tool_input=$(echo "$event_data" | grep -o '"command": "[^"]*"' | head -1 | cut -d'"' -f4)

if echo "$tool_input" | grep -qE "rm -rf /|mkfs|dd if=/dev/zero"; then
    echo "危险命令被阻止: $tool_input" >&2
    exit 2  # 退出码 2 表示阻断
fi

exit 0  # 退出码 0 表示允许
```

## 配置位置

Agent Hooks 支持**用户级别**和**项目级别**的分层配置：

### 用户级别钩子

应用于所有项目（符合 XDG 规范）：

```text
~/.config/agents/hooks/
```

### 项目级别钩子

仅在当前项目内应用：

```
./.agents/hooks/
```

### 加载顺序

钩子按以下顺序加载（后加载的覆盖先加载的同名钩子）：

1. 用户级别钩子（`~/.config/agents/hooks/`）
2. 项目级别钩子（`./.agents/hooks/`）

## Hook 配置 (HOOK.md)

### Frontmatter 字段

| 字段          | 类型    | 必需 | 默认值 | 说明                    |
| ------------- | ------- | ---- | ------ | ----------------------- |
| `name`        | string  | 是   | -      | Hook 标识符 (1-64 字符) |
| `description` | string  | 是   | -      | Hook 描述 (1-1024 字符) |
| `trigger`     | string  | 是   | -      | 触发事件类型            |
| `matcher`     | object  | 否   | -      | 匹配条件                |
| `timeout`     | integer | 否   | 30000  | 超时时间 (毫秒)         |
| `async`       | boolean | 否   | false  | 是否异步执行            |
| `priority`    | integer | 否   | 100    | 执行优先级 (0-1000)     |

### 匹配器 (Matcher)

用于过滤 hook 的触发条件，仅适用于工具相关的事件：

```yaml
---
name: block-dangerous-commands
trigger: before_tool
matcher:
  tool: "Shell" # 工具名正则匹配
  pattern: "rm -rf /|mkfs|>:/dev/sda" # 参数内容正则匹配
---
```

| 字段      | 类型   | 说明                                        |
| --------- | ------ | ------------------------------------------- |
| `tool`    | string | 工具名正则表达式（如 `Shell`, `WriteFile`） |
| `pattern` | string | 工具输入参数的正则表达式匹配                |

### 执行模式

#### 同步模式（默认）

```yaml
---
name: security-check
trigger: before_tool
async: false # 默认，可省略
---
```

**特点：**

- 等待 hook 完成后再继续
- **可以阻断操作**（通过 exit code 2）
- 可以修改输入参数
- 适用于安全检查、权限验证等关键操作

#### 异步模式

```yaml
---
name: auto-format
trigger: after_tool
async: true
---
```

**特点：**

- 立即返回，不等待 hook 完成
- **无法阻断操作**
- 适用于格式化、通知、日志等非关键操作

## 事件类型与阻断能力

| 事件类型             | 触发时机         | 可阻断          | 推荐模式 |
| -------------------- | ---------------- | --------------- | -------- |
| `session_start`      | 会话开始时       | ✅ 可以         | 同步     |
| `session_end`        | 会话结束时       | ✅ 可以         | 同步     |
| `before_agent`       | Agent 执行前     | ✅ 可以         | 同步     |
| `after_agent`        | Agent 执行后     | ✅ 可以         | 同步     |
| `before_tool`        | 工具执行前       | ✅ **推荐**     | **同步** |
| `after_tool`         | 工具执行后       | ✅ 可以         | 同步     |
| `after_tool_failure` | 工具执行失败时   | ✅ 可以         | 同步     |
| `subagent_start`     | 子 Agent 启动时  | ✅ 可以         | 同步     |
| `subagent_stop`      | 子 Agent 停止时  | ✅ 可以         | 同步     |
| `pre_compact`        | 上下文压缩前     | ✅ 可以         | 同步     |
| `before_stop`        | Agent 停止响应前 | ✅ **质量门禁** | **同步** |

## 命令协议

### 输入

脚本通过 **stdin** 接收 JSON 格式的事件信息：

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

脚本通过**退出码**和**输出流**与 Agent 通信：

| 输出流     | 描述                              |
| ---------- | --------------------------------- |
| **退出码** | 执行结果信号                      |
| **stdout** | 机器可解析的 JSON，用于控制与通信 |
| **stderr** | 人类可读文本，用于错误与反馈      |

### 退出码

| 退出码 | 含义 | 行为                                  |
| ------ | ---- | ------------------------------------- |
| `0`    | 成功 | 解析 stdout JSON 作为结果，操作继续   |
| `2`    | 阻断 | **阻断操作**，stderr 内容作为反馈展示 |
| 其他   | 异常 | 记录警告，允许操作继续（Fail Open）   |

### stdout (控制与通信)

**触发条件：** 仅在 Exit Code 为 `0`（成功）时生效。

**示例：**

```bash
echo '{"decision": "allow", "log": "Command validated"}'
exit 0
```

### stderr (错误与反馈)

**触发条件：**

- Exit Code `2` (阻断)：stderr 内容作为阻断理由展示给用户
- 其他非 0 退出码：stderr 仅作为调试/日志文本

**示例：**

```bash
echo "Dangerous command blocked: rm -rf / would destroy the system" >&2
exit 2
```

## 脚本入口点

每个 hook 必须在标准位置提供可执行脚本：

| 优先级 | 入口点           | 说明               |
| ------ | ---------------- | ------------------ |
| 1      | `scripts/run`    | 无扩展名可执行文件 |
| 2      | `scripts/run.sh` | Shell 脚本         |
| 3      | `scripts/run.py` | Python 脚本        |

脚本通过 stdin 接收事件数据，使用退出码传递结果：0 表示允许，2 表示阻断。

## 示例

### 危险命令拦截

**HOOK.md:**

```markdown
---
name: block-dangerous-commands
description: 阻止 rm -rf / 等危险的系统命令
trigger: before_tool
matcher:
  tool: Shell
  pattern: "rm -rf /|mkfs|dd if=/dev/zero"
timeout: 5000
priority: 999
---
```

**scripts/run.sh:**

```bash
#!/bin/bash
event_data=$(cat)
tool_input=$(echo "$event_data" | grep -o '"command": "[^"]*"' | head -1 | cut -d'"' -f4)

dangerous_patterns=("rm -rf /" "mkfs" "dd if=/dev/zero")
for pattern in "${dangerous_patterns[@]}"; do
    if echo "$tool_input" | grep -qE "\b${pattern}\b"; then
        echo "Dangerous command blocked: ${pattern} would destroy the system" >&2
        exit 2
    fi
done

exit 0
```

### 代码自动格式化（异步）

**HOOK.md:**

```markdown
---
name: auto-format-python
description: Auto-format Python files after write
trigger: after_tool
matcher:
  tool: WriteFile
  pattern: "\.py$"
timeout: 30000
async: true
---
```

**scripts/run.sh:**

```bash
#!/bin/bash
black --quiet .
```

### Python Hook 脚本

**scripts/run.py:**

```python
#!/usr/bin/env python3
import json
import sys

def main():
    event = json.load(sys.stdin)
    tool_name = event.get("tool_name", "")
    tool_input = event.get("tool_input", {})

    if tool_name == "Shell":
        command = tool_input.get("command", "")

        dangerous = ["rm -rf /", "mkfs", "dd if=/dev/zero"]
        for pattern in dangerous:
            if pattern in command:
                print(f"Dangerous command detected: {pattern}", file=sys.stderr)
                sys.exit(2)

    print(json.dumps({"decision": "allow"}))
    sys.exit(0)

if __name__ == "__main__":
    main()
```

### 质量门禁 Hook（before_stop）

**HOOK.md:**

```markdown
---
name: enforce-tests
description: 确保测试通过才允许完成任务
trigger: before_stop
timeout: 60000
priority: 999
---
```

**scripts/run.sh:**

```bash
#!/bin/bash
# 在允许 Agent 完成前运行测试
if ! npm test 2>&1; then
    echo "测试通过前不能完成任务" >&2
    exit 2
fi
exit 0
```

当 `before_stop` hook 阻断时（exit 2），Agent 会继续工作，并将 hook 的反馈添加到上下文中：

```
[Hook blocked stop: 测试通过前不能完成任务]
```

## 配置优先级与执行顺序

### 优先级 (Priority)

- 范围: 0 - 1000
- 默认值: 100
- 规则: **数值越高，越早执行**

```yaml
# 安全检查优先执行
priority: 999

# 普通通知后执行
priority: 10
```

### 多 Hook 执行顺序

1. 按优先级降序排序
2. 同优先级按配置顺序执行
3. 任一 hook 阻断则停止执行后续 hook

## 调试

使用 `--debug` 参数查看详细的 hook 执行日志：

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
[HOOK DEBUG] [SYNC] Starting hook 'block-dangerous' for event 'before_tool'
[HOOK DEBUG] [SYNC] Completed hook 'block-dangerous' in 45ms: blocked=True
[HOOK DEBUG] Reason: Dangerous command blocked
```

## 最佳实践

### 1. 根据场景选择模式

| 场景               | 推荐模式 | 原因         |
| ------------------ | -------- | ------------ |
| 安全检查、权限验证 | 同步     | 需要阻断能力 |
| 代码格式化         | 异步     | 不需要等待   |
| 日志记录           | 异步     | 不影响性能   |
| 通知推送           | 异步     | 即时反馈     |

### 2. 设置合理的超时时间

```yaml
# 快速检查：5秒
timeout: 5000

# 复杂分析：60秒
timeout: 60000
```

### 3. 使用 exit code 2 强制阻断

当需要确保操作被阻断时，使用 exit 2：

```bash
#!/bin/bash
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
try:
    if is_dangerous():
        sys.exit(2)
except Exception as e:
    print(f"Hook error: {e}", file=sys.stderr)
    print('{"decision": "allow"}')
    sys.exit(0)
```

### 5. 异步 Hook 注意事项

- 异步 hook 无法修改输入参数
- 异步 hook 的 `decision: deny` 会被忽略
- 异步 hook 的 stdout/stderr 仅用于日志

## 安装 Hook

将 hook 复制到用户或项目级别的 hooks 目录：

```bash
# 用户级别 (XDG)
cp -r /path/to/security-hook ~/.config/agents/hooks/

# 项目级别
cp -r /path/to/security-hook .agents/hooks/
```

作为 git 子模块添加到项目：

```bash
git submodule add https://github.com/yourorg/agenthooks.git .agents/hooks
```

## 参考

- [Agent Hooks 规范定义](../../../agenthooks/docs/zh/SPECIFICATION.md) - 完整的技术规范
- [Agent Hooks 使用指南](../../../agenthooks/docs/zh/GUIDE.md) - 详细的使用指南
- [Agent Hooks 示例](../../../agenthooks/examples/) - 常见用例的示例 hook

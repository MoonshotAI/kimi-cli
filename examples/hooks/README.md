# Kimi Code CLI Hooks 示例

本目录包含 Kimi Code CLI Hooks 的实用示例。

## 快速开始

1. 复制需要的示例到你的配置文件：
   ```bash
   cat examples/hooks/security-hooks.toml >> ~/.kimi/config.toml
   ```

2. 使用 `--debug-hooks` 测试：
   ```bash
   kimi --debug-hooks
   ```

## 示例列表

| 文件 | 描述 |
|------|------|
| `security-hooks.toml` | 安全检查相关的 hooks |
| `git-hooks.toml` | Git 集成 hooks |
| `code-quality-hooks.toml` | 代码质量检查 hooks |
| `notification-hooks.toml` | 通知推送 hooks |

## 自定义示例

创建自己的 hook 脚本：

```python
#!/usr/bin/env python3
# my-hook.py
import json
import sys

# 读取事件数据
event = json.load(sys.stdin)

# 你的逻辑
if event.get("event_type") == "before_tool":
    tool_name = event.get("tool_name")
    # ...

# 输出结果
result = {
    "decision": "allow",  # or "deny" or "ask"
    "reason": "Optional reason"
}
print(json.dumps(result))
```

然后在配置中使用：

```toml
[[hooks.before_tool]]
name = "my-custom-hook"
type = "command"
command = "python /path/to/my-hook.py"
```

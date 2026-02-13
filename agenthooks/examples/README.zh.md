# 示例钩子

此目录包含演示各种用例的 Agent Hooks 示例。

## 文档

- [English Documentation](./README.md)
- [中文文档](./README.zh.md)

## 可用示例

### security-hook

**用途：** 阻止危险的系统命令

**触发器：** `before_tool`

**特性：**

- 阻止 `rm -rf /`、`mkfs`、`dd if=/dev/zero`
- 同步执行（如果是危险的则阻止）
- 高优先级 (999)

### notify-hook

**用途：** 会话结束时发送通知

**触发器：** `session_end`

**特性：**

- 异步执行（非阻塞）
- 适用于日志/审计
- 低优先级 (50)

### auto-format-hook

**用途：** 写入后自动格式化 Python 文件

**触发器：** `after_tool`

**特性：**

- 匹配 Python 文件 (`.py` 扩展名)
- 运行 `black` 格式化工具
- 异步执行

## 使用这些示例

将任何示例复制到您的钩子目录：

```bash
# 用户级别 (XDG)
cp -r security-hook ~/.config/agents/hooks/

# 项目级别
cp -r security-hook .agents/hooks/
```

然后根据需要自定义 `HOOK.md` 和脚本。

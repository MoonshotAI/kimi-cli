# Agent Hooks

[Agent Hooks](https://github.com/yourorg/agenthooks) 是一个开放的格式，用于为 AI 代理定义事件驱动的钩子。钩子允许您拦截、修改或响应代理生命周期事件。

钩子是包含可执行脚本和配置的文件夹，代理可以在其生命周期的特定时间点发现并执行这些脚本。一次编写，到处使用。

## 快速开始

- [规范定义](./docs/zh/SPECIFICATION.md) - 完整的格式规范
- [使用指南](./docs/zh/GUIDE.md) - 钩子发现与使用指南
- [示例](./examples/) - 常见用例的示例钩子
- [参考实现](./hooks-ref/) - 参考实现库（CLI 和 Python API）

## 概述

Agent Hooks 使您能够：

- **拦截工具调用** - 阻止或修改工具执行（例如防止危险命令）
- **响应生命周期事件** - 在会话开始/结束或代理激活时运行代码
- **执行策略** - 确保符合团队标准
- **自动化工作流** - 在特定事件后触发操作

## 快速示例

```tree
block-dangerous-commands/
├── HOOK.md           # 钩子元数据和配置
└── scripts/
    └── run.sh        # 可执行脚本
```

**HOOK.md:**

```markdown
---
name: block-dangerous-commands
description: 阻止 rm -rf / 等危险的 shell 命令
trigger: before_tool
matcher:
  tool: Shell
  pattern: "rm -rf /|mkfs|dd if=/dev/zero"
---

# 阻止危险命令

此钩子阻止执行危险的系统命令。

## 行为

触发时，此钩子将：

1. 检查命令是否匹配危险模式
2. 如果匹配则使用退出码 2 阻止执行
3. 记录尝试以供审计
```

## 安装

作为 git 子模块添加到您的项目：

```bash
git submodule add https://github.com/yourorg/agenthooks.git .agents/hooks
```

或创建您自己的钩子目录：

```bash
mkdir -p ~/.config/agents/hooks/    # 用户级别 (XDG)
# 或
mkdir -p .agents/hooks/             # 项目级别
```

## 支持的代理平台

Agent Hooks 得到以下平台的支持：

- [Kimi Code CLI](https://github.com/moonshotai/kimi-cli)

## 文档

- [English Documentation](./README.md)
- [中文文档](./README.zh.md)

## 许可证

Apache 2.0 - 详见 [LICENSE](./LICENSE)

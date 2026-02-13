# Agent Hooks 使用指南

本指南涵盖钩子的发现、安装和使用。

## 钩子发现机制

Agent Hooks 支持用户级别和项目级别的钩子，具有自动发现和合并功能。

### 发现路径

#### 用户级别钩子

应用于所有项目（符合 XDG 规范）：

1. `~/.config/agents/hooks/`

#### 项目级别钩子

仅在项目内应用：

1. `.agents/hooks/`

### 加载优先级

钩子按以下顺序加载（后加载的覆盖先加载的同名钩子）：

1. 用户级别钩子
2. 项目级别钩子

## 目录结构

```text
~/.config/agents/             # 用户级别 (XDG)
└── hooks/
    ├── security/
    │   ├── HOOK.md
    │   └── scripts/
    │       └── run.sh
    └── logging/
        ├── HOOK.md
        └── scripts/
            └── run.sh

./my-project/
└── .agents/                  # 项目级别
    └── hooks/
        └── project-specific/
            ├── HOOK.md
            └── scripts/
                └── run.sh
```

## 合并行为

当钩子具有相同名称时：

- 项目级别钩子覆盖用户级别钩子
- 记录警告日志

当触发器有多个钩子时：

- 按优先级降序排序
- 所有钩子默认都是**同步**执行（`async = false`）
- 异步钩子（`async = true`）在同步钩子后并行执行
- 第一个阻断决策停止执行后续钩子

## 脚本入口点

每个钩子必须在标准位置提供可执行脚本：

| 优先级 | 入口点 | 说明 |
|--------|--------|------|
| 1 | `scripts/run` | 无扩展名可执行文件 |
| 2 | `scripts/run.sh` | Shell 脚本 |
| 3 | `scripts/run.py` | Python 脚本 |

脚本通过 stdin 接收事件数据。使用退出码传递结果：0 表示允许，2 表示阻断。阻断时 stderr 内容展示给用户。

## 配置文件（可选）

可选的 `hooks.toml` 可以指定额外选项：

```toml
[hooks]
enabled = true
debug = false

[hooks.defaults]
timeout = 30000
async = false

# 禁用特定钩子
[[hooks.disable]]
name = "verbose-logger"

# 覆盖钩子设置
[[hooks.override]]
name = "security-check"
priority = 999
```

## 安装示例

将任何示例复制到您的钩子目录：

```bash
# 用户级别 (XDG)
cp -r security-hook ~/.config/agents/hooks/

# 项目级别
cp -r security-hook .agents/hooks/
```

然后根据需要自定义 `HOOK.md` 和脚本。

## 文档

- [English Documentation](./GUIDE.md)
- [中文文档](./GUIDE.zh.md)

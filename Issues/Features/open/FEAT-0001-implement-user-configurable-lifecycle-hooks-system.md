---
id: FEAT-0001
uid: feat0001
type: feature
status: open
stage: draft
title: "Hooks 系统核心架构 (基于现有配置层扩展)"
created_at: '2026-01-15T00:00:00'
updated_at: '2026-02-13T13:00:00'
parent: EPIC-0001
dependencies: []
related: []
domains: []
tags:
- '#FEAT-0001'
- '#EPIC-0001'
files:
- src/kimi_cli/hooks/__init__.py
- src/kimi_cli/hooks/config.py
- src/kimi_cli/hooks/models.py
- src/kimi_cli/hooks/manager.py
- src/kimi_cli/config.py
- tests/unit/hooks/test_config.py
- tests/unit/hooks/test_models.py
- tests/unit/hooks/test_manager.py
- examples/hooks/security.toml
- examples/hooks/productivity.toml
criticality: high
solution: null
---

## FEAT-0001: Hooks 系统核心架构 (基于现有配置层扩展)

## 背景说明

Kimi CLI 已具备完善的配置系统 (`src/kimi_cli/config.py`)：
- 支持 TOML/JSON 双格式
- 全局配置路径 `~/.kimi/config.toml`
- Pydantic 模型验证 (`Config`, `LLMModel`, `LLMProvider` 等)
- 完整的 `load_config()` / `save_config()` API

本 Feature **无需重复实现配置系统**，而是在现有配置层基础上扩展 Hooks 支持。

## 目标

在现有配置系统中集成 Hooks 支持，实现：
1. Hooks 配置模型设计与验证
2. `HookManager` 核心管理类（注册、匹配、执行）
3. `Command` 类型钩子执行引擎

---

## 详细设计

### 1. 设计原则

| 原则 | 体现 |
|------|------|
| **Pydantic 配置验证** | 所有配置使用 `BaseModel` |
| **Dataclass 领域模型** | 运行时对象使用 `@dataclass(frozen=True, slots=True, kw_only=True)` |
| **TOML 优先** | 主配置格式为 TOML，兼容 JSON |
| **异步优先** | 使用 `asyncio`，`async/await` |
| **类型安全** | 严格类型注解，`from __future__ import annotations` |
| **命名规范** | Pythonic `snake_case`，事件名使用 `before_` / `after_` 前缀 |

### 2. 配置模型设计

见 `src/kimi_cli/hooks/config.py`

### 3. 运行时模型设计

见 `src/kimi_cli/hooks/models.py`

### 4. HookManager 设计

见 `src/kimi_cli/hooks/manager.py`

### 5. 与现有架构集成

见 `src/kimi_cli/config.py`

### 6. 输入/输出 JSON 规范

**输入格式 (stdin)**:
```json
{
  "event_type": "before_tool",
  "timestamp": "2026-01-15T10:30:00+08:00",
  "session_id": "sess_abc123",
  "work_dir": "/home/user/project",
  "tool_name": "Shell",
  "tool_input": {
    "command": "rm -rf /tmp/test"
  },
  "tool_use_id": "tool_123"
}
```

**输出格式 (stdout)**:
```json
{
  "decision": "allow|deny|ask",
  "reason": "原因说明（当 decision 为 deny 时必需）",
  "modified_input": {
    "command": "rm -rf /tmp/test_backup"
  },
  "additional_context": "额外的上下文信息"
}
```

**Exit Code 语义**:
| Exit Code | 含义 | 行为 |
|-----------|------|------|
| `0` | Success | 解析 stdout JSON |
| `2` | System Block | 阻塞动作，stderr 作为反馈 |
| 其他 | Warning | 非阻塞错误，记录日志 |

### 7. 配置示例

```toml
# ~/.kimi/config.toml

[hooks]

# Session 启动时注入项目信息
[[hooks.session_start]]
name = "inject-git-info"
type = "Command"
command = """
git_info=$(git log -1 --oneline 2>/dev/null || echo "Not a git repo")
echo "{\"additional_context\": \"Last commit: $git_info\"}"
"""
description = "Inject recent git commit info"

# 危险命令拦截
[[hooks.before_tool]]
name = "block-dangerous-rm"
type = "Command"
matcher = { tool = "Shell", pattern = "rm -rf\\s*/" }
command = "echo '{\"decision\": \"deny\", \"reason\": \"禁止删除根目录\"}'"
timeout = 100
description = "Block dangerous rm commands"

# 文件修改后自动格式化（异步执行）
[[hooks.after_tool]]
name = "auto-format"
type = "Command"
matcher = { tool = "WriteFile|Replace" }
command = "prettier --write \"\$KIMI_WORK_DIR/\$(cat | jq -r '.tool_input.file_path')\" 2>/dev/null || true"
async = true
description = "Auto-format files after editing"
```

---

## 技术任务 (Technical Tasks)

### Phase 1: 核心架构
- [x] 创建 `src/kimi_cli/hooks/` 目录结构
  - `config.py` - 配置模型
  - `models.py` - 运行时模型
  - `manager.py` - HookManager 实现
- [x] 在 `Config` 模型中增加 `hooks: HooksConfig` 字段
- [x] 实现 `HookManager` 核心类
  - `__init__(config: HooksConfig)` 从配置加载钩子
  - `execute(event_type, event)` 并行执行匹配的钩子
  - Matcher 机制（正则匹配、条件筛选）
  - 超时控制（使用 `asyncio.wait_for`）
- [x] 实现 Command 类型钩子执行引擎
  - `subprocess_shell` 执行命令
  - stdin JSON 输入
  - stdout/stderr 捕获
  - Exit Code 处理

### Phase 2: 集成测试
- [x] 编写单元测试
  - 配置解析测试
  - HookManager 执行测试
  - Matcher 匹配测试
  - 超时处理测试
- [x] 提供示例配置文件
  - `examples/hooks/security.toml` - 安全相关 hooks
  - `examples/hooks/productivity.toml` - 效率相关 hooks

---

## 验收标准

- [x] 能够在 `~/.kimi/config.toml` 中配置 hooks 字段并成功解析
- [x] `HookManager` 能正确根据事件类型和 matcher 筛选钩子
- [x] `Command` 类型钩子能正确执行，并通过 stdin 接收上下文
- [x] Exit Code 0 解析 stdout JSON，Exit Code 2 阻塞动作
- [x] 钩子执行支持超时控制，超时后不会阻塞主流程（Fail Open）
- [x] 提供单元测试覆盖核心逻辑
- [x] 命名使用 snake_case，符合 Kimi CLI 代码风格

---

## 文件结构

```
src/kimi_cli/hooks/
├── __init__.py
├── config.py      # Pydantic 配置模型
├── models.py      # Dataclass 运行时模型
└── manager.py     # HookManager 实现

tests/unit/hooks/
├── test_config.py
├── test_manager.py
└── test_matcher.py

examples/hooks/
├── security.toml
└── productivity.toml
```

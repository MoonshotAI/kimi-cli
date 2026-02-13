---
id: FEAT-0003
uid: feat0003
type: feature
status: open
stage: doing
title: "工具拦截钩子 (PreToolUse / PostToolUse)"
created_at: '2026-01-15T00:00:00'
updated_at: '2026-02-13T13:35:00'
parent: EPIC-0001
dependencies:
- FEAT-0001
related: []
domains: []
tags:
- '#FEAT-0003'
- '#EPIC-0001'
- '#FEAT-0001'
files:
- src/kimi_cli/soul/toolset.py
- src/kimi_cli/soul/kimisoul.py
criticality: high
solution: null
---

## FEAT-0003: 工具拦截钩子 (PreToolUse / PostToolUse)

## 关联 Epic
- #EPIC-0001

## 依赖
- #FEAT-0001 (Hooks 系统核心架构)

## 目标

在工具调用前后插入钩子拦截点，实现：
1. `PreToolUse` - 工具执行前触发（权限检查、参数修改、危险命令拦截）
2. `PostToolUse` - 工具执行后触发（结果处理、日志记录、副作用分析）
3. 高频触发场景下的性能优化

## 技术任务

### 1. PreToolUse 钩子点注入
- [x] 定位工具调用代码（`src/kimi_cli/soul/toolset.py` 或 `KimiToolset.run_tool()`）
- [x] 在工具执行前注入 `PreToolUse` 钩子调用
- [x] 传递上下文：工具名称、参数、当前会话状态
- [x] 支持钩子返回值控制流程：
  - `continue` - 继续执行工具（默认）
  - `block` - 阻止工具执行，返回钩子提供的消息
  - `modify` - 使用钩子修改后的参数执行

### 2. PostToolUse 钩子点注入
- [x] 在工具执行后注入 `PostToolUse` 钩子调用
- [x] 传递上下文：工具名称、原始参数、执行结果、执行时长、是否报错
- [x] 支持钩子修改返回值

### 3. 性能优化
- [x] 实现钩子结果缓存（针对相同的工具调用参数）
- [x] 支持异步钩子（不阻塞主流程）
- [x] 提供钩子执行统计（调用次数、平均耗时）

### 4. 集成测试
- [x] 测试 PreToolUse 阻止工具执行
- [x] 测试 PreToolUse 修改工具参数
- [x] 测试 PostToolUse 处理工具结果
- [x] 测试高频场景下的性能

## 钩子上下文设计

### PreToolUse Event Context
```json
{
  "event": "PreToolUse",
  "timestamp": "2026-01-15T10:30:00Z",
  "tool_name": "Shell",
  "tool_input": {
    "command": "rm -rf /tmp/test"
  },
  "tool_use_id": "tool_123"
}
```

### PostToolUse Event Context
```json
{
  "event": "PostToolUse",
  "timestamp": "2026-01-15T10:30:01Z",
  "tool_name": "Shell",
  "tool_input": {
    "command": "rm -rf /tmp/test"
  },
  "tool_output": {
    "stdout": "",
    "stderr": ""
  },
  "duration_ms": 100,
  "error": null
}
```

## 配置示例

```toml
# 危险命令拦截
[[hooks.before_tool]]
name = "block-dangerous-commands"
event = "PreToolUse"
type = "Command"
matcher = { tool = "Shell", pattern = "rm -rf /|mkfs|dd if=/dev/zero" }
command = "echo '{\"decision\": \"deny\", \"reason\": \"危险命令被拦截\"}'"

# 自动添加 git 提交信息
[[hooks.after_tool]]
name = "git-commit-helper"
event = "PostToolUse"
type = "Command"
matcher = { tool = "WriteFile", pattern = "\\.py$" }
command = "git diff --stat | head -5"
async = true
```

## 验收标准

- [x] PreToolUse 钩子能在工具执行前触发
- [x] 钩子可以阻止工具执行并返回自定义消息
- [x] 钩子可以修改工具参数
- [x] PostToolUse 钩子能在工具执行后触发
- [x] 高频工具调用场景下性能下降不超过 10%

## 相关代码位置

- `src/kimi_cli/soul/toolset.py` - 工具调用核心逻辑
- `src/kimi_cli/soul/kimisoul.py` - Agent 循环

---
id: FEAT-0004
uid: feat0004
type: feature
status: closed
stage: done
solution: implemented
title: 高级钩子类型与调试能力
created_at: '2026-01-15T00:00:00'
updated_at: '2026-02-13T13:54:40'
parent: EPIC-0001
dependencies:
- FEAT-0001
related: []
domains: []
tags:
- '#FEAT-0004'
- '#EPIC-0001'
- '#FEAT-0001'
files:
- src/kimi_cli/hooks/
- docs/hooks.md
criticality: medium
solution: null # implemented, cancelled, wontfix, duplicate
---

## FEAT-0004: 高级钩子类型与调试能力

## 关联 Epic
- #EPIC-0001

## 依赖
- #FEAT-0001 (Hooks 系统核心架构)
- #FEAT-0002 (Session 生命周期钩子) - 可选
- #FEAT-0003 (工具拦截钩子) - 可选

## 目标

实现高级钩子类型和调试功能：
1. `Prompt` 类型钩子 - 使用 LLM 进行逻辑判断
2. `Agent` 类型钩子 - 启动子 Agent 进行复杂验证
3. `--debug` 钩子执行日志
4. 官方文档与示例集

## 技术任务

### 1. Prompt 类型钩子
- [x] 实现 `PromptHookExecutor`：
  - 调用 LLM 对事件上下文进行判断
  - 支持自定义 system prompt
  - 解析 LLM 返回的结构化决策（JSON/YAML）
- [x] 设计默认 Prompt 模板：
  - 危险命令判断
  - 代码质量检查
  - 敏感信息检测
- [x] 支持在 HookConfig 中配置 prompt 内容

### 2. Agent 类型钩子
- [x] 实现 `AgentHookExecutor`：
  - 启动子 Agent 进行复杂验证
  - 传递上下文给子 Agent
  - 解析子 Agent 的执行结果
- [x] 设计使用场景：
  - 运行测试并分析失败原因
  - 代码审查和风格检查
  - 安全漏洞扫描

### 3. 调试能力
- [x] 实现 `--debug-hooks` 命令行参数
- [x] 记录每个钩子的执行日志：
  - 触发事件类型
  - 钩子名称和类型
  - 输入上下文
  - 执行结果和耗时
- [x] 提供钩子执行统计命令

### 4. 文档与示例
- [x] 编写 Hooks 系统用户文档
- [x] 提供 5+ 个实用钩子示例：
  - Git 集成
  - 代码格式化
  - 安全扫描
  - 测试自动运行
  - 通知推送

## 配置示例

### Prompt 类型钩子
```toml
[[hooks.before_tool]]
name = "ai-security-check"
type = "Prompt"
matcher = { tool = "Shell" }
prompt = """
判断以下 Shell 命令是否安全：
命令: {{tool_input.command}}

如果命令可能破坏数据或系统，返回：
{\"decision\": \"deny\", \"reason\": \"原因\"}

否则返回：
{\"decision\": \"allow\"}
"""
```

### Agent 类型钩子
```toml
[[hooks.after_tool]]
name = "test-analyzer"
type = "Agent"
matcher = { tool = "Shell", pattern = "pytest" }
task = """
分析测试结果，如果有失败的测试：
1. 找出失败原因
2. 提供修复建议
3. 返回简洁的总结
"""
```

## 验收标准

- [x] Prompt 类型钩子能调用 LLM 进行判断
- [x] Agent 类型钩子能启动子 Agent 并获取结果
- [x] `--debug-hooks` 参数能输出详细的钩子执行日志
- [x] 提供完整的用户文档和示例
- [x] 示例钩子覆盖常见使用场景

## 实现细节

### 新增文件
- 无新增文件，所有改动在现有 hooks 模块中

### 修改文件
- `src/kimi_cli/hooks/config.py` - 添加 `PROMPT` 和 `AGENT` hook 类型及配置类
- `src/kimi_cli/hooks/manager.py` - 实现 `PromptHookExecutor`、`AgentHookExecutor` 和 `HookDebugger`
- `src/kimi_cli/hooks/__init__.py` - 导出新的类和类型
- `src/kimi_cli/cli/__init__.py` - 添加 `--debug-hooks` CLI 参数
- `src/kimi_cli/app.py` - 传递 `debug_hooks` 参数
- `src/kimi_cli/soul/agent.py` - 在 Runtime 中启用 hook 调试

### 新增文档
- `docs/zh/configuration/hooks.md` - 中文 Hooks 配置文档
- `docs/en/configuration/hooks.md` - 英文 Hooks 配置文档

### 新增示例
- `examples/hooks/README.md` - 示例说明
- `examples/hooks/security-hooks.toml` - 安全相关 hooks
- `examples/hooks/git-hooks.toml` - Git 集成 hooks
- `examples/hooks/code-quality-hooks.toml` - 代码质量 hooks
- `examples/hooks/notification-hooks.toml` - 通知推送 hooks

## Review Comments

### Code Review

- [x] PromptHookConfig 和 AgentHookConfig 配置类已实现
- [x] PromptHookExecutor 支持 LLM 决策和自定义提示词
- [x] AgentHookExecutor 支持子 Agent 验证任务
- [x] HookDebugger 提供详细的执行日志和统计
- [x] --debug-hooks CLI 参数已添加
- [x] 文档已更新（中英文）
- [x] 示例 hooks 已提供（安全、Git、代码质量、通知）
- [x] 所有现有测试通过

## 相关代码位置

- `src/kimi_cli/hooks/` - 钩子系统核心
- `docs/hooks.md` - 用户文档

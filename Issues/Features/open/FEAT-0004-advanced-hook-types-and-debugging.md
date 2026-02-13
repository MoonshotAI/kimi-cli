---
id: FEAT-0004
uid: feat0004
type: feature
status: open
stage: draft
title: "高级钩子类型与调试能力"
created_at: '2026-01-15T00:00:00'
updated_at: '2026-02-13T13:00:00'
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
solution: null
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
- [ ] 实现 `PromptHookExecutor`：
  - 调用 LLM 对事件上下文进行判断
  - 支持自定义 system prompt
  - 解析 LLM 返回的结构化决策（JSON/YAML）
- [ ] 设计默认 Prompt 模板：
  - 危险命令判断
  - 代码质量检查
  - 敏感信息检测
- [ ] 支持在 HookConfig 中配置 prompt 内容

### 2. Agent 类型钩子
- [ ] 实现 `AgentHookExecutor`：
  - 启动子 Agent 进行复杂验证
  - 传递上下文给子 Agent
  - 解析子 Agent 的执行结果
- [ ] 设计使用场景：
  - 运行测试并分析失败原因
  - 代码审查和风格检查
  - 安全漏洞扫描

### 3. 调试能力
- [ ] 实现 `--debug-hooks` 命令行参数
- [ ] 记录每个钩子的执行日志：
  - 触发事件类型
  - 钩子名称和类型
  - 输入上下文
  - 执行结果和耗时
- [ ] 提供钩子执行统计命令

### 4. 文档与示例
- [ ] 编写 Hooks 系统用户文档
- [ ] 提供 5+ 个实用钩子示例：
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

- [ ] Prompt 类型钩子能调用 LLM 进行判断
- [ ] Agent 类型钩子能启动子 Agent 并获取结果
- [ ] `--debug-hooks` 参数能输出详细的钩子执行日志
- [ ] 提供完整的用户文档和示例
- [ ] 示例钩子覆盖常见使用场景

## 相关代码位置

- `src/kimi_cli/hooks/` - 钩子系统核心
- `docs/hooks.md` - 用户文档

---
id: EPIC-0001
uid: epic0001
type: epic
status: open
stage: doing
title: 为 Kimi CLI 引入通用生命周期钩子系统 (Hooks System)
created_at: '2026-01-15T00:00:00'
updated_at: '2026-02-13T13:20:00'
parent: EPIC-0000
dependencies: []
related: []
domains: []
tags:
- '#EPIC-0001'
- '#EPIC-0000'
files: []
criticality: high
solution: null
progress: 3/4
files_count: 0
---

## EPIC-0001: 为 Kimi CLI 引入通用生命周期钩子系统 (Hooks System)

## 背景与目标

目前 Kimi CLI 的生命周期是固定的，用户无法在不修改核心代码的情况下注入自定义上下文或触发外部工作流。引入 Hooks 系统旨在提升 Kimi CLI 的可扩展性，使其能够更好地集成到开发者的本地自动化流中。

## 社区调研

- **需求确认**：Issue #785 明确提出需要用户可配置的生命周期钩子（SessionStart, PreToolUse 等）。
- **现状分析**：存在相关尝试（如 PR #864），但仅实现了单一的 `--starting-prompt` 功能且未被合并。目前主干代码中尚无通用的 Hooks 机制。

## 竞品/参考分析 (Benchmarking)

通过对 Claude Code、OpenAI Codex 和 Google Gemini CLI 的调研，得出以下核心设计参考：

### 1. 生命周期覆盖 (Claude Code 模式)

- **Session 级**：`SessionStart` (环境初始化), `SessionEnd` (清理)。
- **消息级**：`UserPromptSubmit` (Prompt 过滤/增强), `Stop` (响应后置处理)。
- **工具级**：`PreToolUse` (权限检查/参数修改), `PostToolUse` (结果反馈)。
- **任务级**：`SubagentStart/Stop`, `TaskCompleted` (质量门禁)。

### 2. 钩子类型

- **Command**：运行 Shell 脚本 (KISS 原则，最通用)。
- **Prompt**：利用 LLM 进行逻辑判断。
- **Agent**：启动子 Agent 进行复杂验证 (如：运行测试并分析失败原因)。

### 3. 配置管理

- **位置**：`~/.kimi/hooks.toml` (或 `config.toml` 中的 `[hooks]` 字段)。
- **格式**：TOML，支持多钩子定义和条件匹配。

## 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Kimi CLI Core                           │
├─────────────┬───────────────────┬───────────────────────────┤
│   Session   │     Agent Loop    │        Tools              │
│   Manager   │                   │                           │
├──────┬──────┼──────────┬────────┼───────────┬───────────────┤
│      │      │          │        │           │               │
▼      ▼      ▼          ▼        ▼           ▼               ▼
Start  End  Before    After   BeforeTool  AfterTool      Subagent
│      │   Agent     Agent   │           │               Start/Stop
│      │              │      │           │                   │
└──────┴──────────────┴──────┴───────────┴───────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   HookManager    │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         ┌────────┐    ┌────────┐    ┌────────┐
         │Command │    │ Prompt │    │ Agent  │
         │  Hook  │    │  Hook  │    │  Hook  │
         └────────┘    └────────┘    └────────┘
```

## 子任务 (Features)

- [x] **FEAT-0001**: Hooks 系统核心架构 (配置层扩展、HookManager、Command 执行引擎) - ✅ Completed
- [x] **FEAT-0002**: Session 生命周期钩子集成 (SessionStart, SessionEnd) - ✅ Completed
- [x] **FEAT-0003**: 工具拦截钩子 (PreToolUse / PostToolUse) - ✅ Completed
- [ ] **FEAT-0004**: 高级钩子类型与调试能力 (Prompt/Agent 类型、--debug 日志)

## 验收标准

- 用户可以通过配置文件定义在 `SessionStart` 时注入特定的系统信息。
- 用户可以定义钩子拦截危险的 Shell 命令 (如 `rm -rf`)。
- 系统支持并行的钩子执行，且具备超时控制。
- 提供完善的调试日志 (`--debug`)。

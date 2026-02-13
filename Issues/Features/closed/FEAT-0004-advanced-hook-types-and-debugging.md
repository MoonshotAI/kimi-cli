---
id: FEAT-0004
uid: feat0004
type: feature
status: closed
stage: done
solution: implemented
title: Hooks 调试能力与示例集
created_at: "2026-01-15T00:00:00"
updated_at: "2026-02-13T15:00:00"
parent: EPIC-0001
dependencies:
  - FEAT-0001
related: []
domains: []
tags:
  - "#FEAT-0004"
  - "#EPIC-0001"
  - "#FEAT-0001"
files:
  - src/kimi_cli/hooks/
  - docs/hooks.md
criticality: medium
---

## FEAT-0004: Hooks 调试能力与示例集

## 关联 Epic

- #EPIC-0001

## 依赖

- #FEAT-0001 (Hooks 系统核心架构)
- #FEAT-0002 (Session 生命周期钩子) - 可选
- #FEAT-0003 (工具拦截钩子) - 可选

## 目标

实现 hooks 调试功能和完整的示例集：

1. `--debug-hooks` 钩子执行日志
2. 钩子执行统计
3. 官方文档与示例集

## 技术任务

### 1. 调试能力

- [x] 实现 `--debug-hooks` 命令行参数
- [x] 记录每个钩子的执行日志：
  - 触发事件类型
  - 钩子名称和类型
  - 输入上下文
  - 执行结果和耗时
- [x] 提供钩子执行统计命令

### 2. 文档与示例

- [x] 编写 Hooks 系统用户文档
- [x] 提供实用钩子示例：
  - Git 集成
  - 代码格式化
  - 安全扫描
  - 通知推送

## 配置示例

### 调试模式

```bash
kimi --debug-hooks
```

### Command 类型钩子

```toml
[[hooks.before_tool]]
name = "security-check"
type = "command"
matcher = { tool = "Shell", pattern = "rm -rf /" }
command = "echo '{\"decision\": \"deny\", \"reason\": \"Dangerous command\"}'"
```

## 验收标准

- [x] `--debug-hooks` 参数能输出详细的钩子执行日志
- [x] 提供完整的用户文档和示例
- [x] 示例钩子覆盖常见使用场景

## 实现细节

### 修改文件

- `src/kimi_cli/hooks/config.py` - HookConfig 配置类
- `src/kimi_cli/hooks/manager.py` - HookExecutor 和 HookDebugger
- `src/kimi_cli/hooks/__init__.py` - 导出类型
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

- [x] HookConfig 配置类已实现
- [x] HookExecutor 支持命令执行
- [x] HookDebugger 提供详细的执行日志和统计
- [x] --debug-hooks CLI 参数已添加
- [x] 文档已更新（中英文）
- [x] 示例 hooks 已提供（安全、Git、代码质量、通知）
- [x] 所有现有测试通过

## 相关代码位置

- `src/kimi_cli/hooks/` - 钩子系统核心
- `docs/hooks.md` - 用户文档

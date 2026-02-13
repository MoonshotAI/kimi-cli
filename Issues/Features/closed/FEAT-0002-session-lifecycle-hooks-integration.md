---
id: FEAT-0002
uid: feat0002
type: feature
status: closed
stage: done
title: "Session 生命周期钩子集成"
created_at: '2026-01-15T00:00:00'
updated_at: '2026-02-13T13:35:00'
parent: EPIC-0001
dependencies:
- FEAT-0001
related: []
domains: []
tags:
- '#FEAT-0002'
- '#EPIC-0001'
- '#FEAT-0001'
files:
- src/kimi_cli/app.py
- src/kimi_cli/soul/agent.py
- src/kimi_cli/tools/shell.py
criticality: high
solution: implemented
---

## FEAT-0002: Session 生命周期钩子集成

## 关联 Epic
- #EPIC-0001

## 依赖
- #FEAT-0001 (Hooks 系统核心架构)

## 目标

在 Kimi CLI 的 Session 生命周期中集成钩子触发点，实现：
1. `SessionStart` - 会话启动时触发（可用于注入项目上下文、环境检查）
2. `SessionEnd` - 会话结束时触发（可用于清理、生成报告）
3. 环境变量持久化机制（让 SessionStart 设置的变量影响后续工具调用）

## 技术任务

### 1. SessionStart 钩子点注入
- [x] 定位 Session 初始化代码（`app.py` 中 `KimiCLI.create()` 或 `Runtime` 初始化）
- [x] 在 Session 就绪后、首条用户消息前注入 `SessionStart` 钩子调用
- [x] 传递上下文信息：工作目录、启动参数、当前模型等
- [x] 处理钩子输出：将 stdout 作为系统消息注入会话上下文

### 2. SessionEnd 钩子点注入
- [x] 定位 Session 结束代码（正常退出、异常退出）
- [x] 注入 `SessionEnd` 钩子调用
- [x] 传递上下文信息：会话时长、总步数、是否异常等
- [x] 确保钩子执行完成后再清理资源

### 3. 环境变量持久化机制
- [x] 设计环境变量传递协议（如 `KIMI_ENV_FILE` 临时文件）
- [x] SessionStart 钩子执行后，读取其设置的环境变量
- [x] 将环境变量应用到后续所有 Shell 工具调用
- [x] 考虑跨平台兼容性（Unix/Windows）

### 4. 集成测试
- [x] 编写测试：SessionStart 钩子正确触发并注入上下文
- [x] 编写测试：环境变量从钩子传递到 Shell 工具
- [x] 编写测试：SessionEnd 钩子在退出时触发

## 钩子上下文设计

### SessionStart Event Context
```json
{
  "event": "SessionStart",
  "timestamp": "2026-01-15T10:30:00Z",
  "work_dir": "/home/user/project",
  "model": "kimi-k2",
  "args": {
    "yolo": false,
    "thinking": true
  }
}
```

### SessionEnd Event Context
```json
{
  "event": "SessionEnd",
  "timestamp": "2026-01-15T11:00:00Z",
  "duration_seconds": 1800,
  "total_steps": 42,
  "exit_reason": "user_exit|error|timeout"
}
```

## 配置示例

```toml
[[hooks.session_start]]
event = "SessionStart"
type = "Command"
command = """
  echo "{\"role\": \"system\", \"content\": \"Current branch: $(git branch --show-current)\"}"
"""

[[hooks.session_start]]
event = "SessionStart"
type = "Command"
command = "echo 'export KIMI_PROJECT_TYPE=python' > /tmp/kimi_env"

[[hooks.session_end]]
event = "SessionEnd"
type = "Command"
command = "echo 'Session ended at $(date)' >> ~/.kimi/session.log"
```

## 验收标准

- [x] Session 启动时自动触发配置的所有 `SessionStart` 钩子
- [x] 钩子 stdout 可作为系统消息注入当前会话
- [x] SessionStart 钩子设置的环境变量能被后续 Shell 工具读取
- [x] Session 结束时触发 `SessionEnd` 钩子
- [x] 钩子执行失败不影响主流程（记录警告日志）

## 相关代码位置

- `src/kimi_cli/app.py` - `KimiCLI.create()`, `KimiCLI.run()`
- `src/kimi_cli/soul/agent.py` - `Runtime`, `Agent` 初始化
- `src/kimi_cli/tools/shell.py` - Shell 工具实现（环境变量注入点）

## Review Comments

- [x] Self-Review

# Session Context

## User Prompts

### Prompt 1

Implement the following plan:

# Fix: WebSocket reconnect storm — 重构 useSessionStream 依赖关系

## Context

Web UI 切换 session 时出现 WebSocket 快速重连风暴（每秒数十次 open/close）。根因是 PR #1359 (`416bc1b`) 为 `resetState` 的 `useCallback` 依赖数组新增了 `slashCommands.length`，导致 `resetState` 回调引用不稳定，触发 `useLayoutEffect` 循环执行。

## 问题分析：当前完整依赖链

### 关键函数依赖关系（当前代码）
...

### Prompt 2

深度review一下这个实现有什么其他可能的问题


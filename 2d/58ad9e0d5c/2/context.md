# Session Context

## User Prompts

### Prompt 1

Implement the following plan:

# FetchURL tooltip 根据平台显示 Cmd/Ctrl

## Context

上一轮已实现 FetchURL 的 Ctrl/Cmd+Click 打开完整链接功能，但 `title` tooltip 硬编码了 `"Ctrl+Click to open URL"`。在 Mac 上应显示 `"Cmd+Click to open URL"`。

## 修改文件

`web/src/components/ai-elements/tool.tsx` — `ToolHeader` 组件

## 实现

1. 导入已有的 `isMacOS` 工具函数（来自 `@/hooks/utils`，项目中已广泛使用）
2. 将 `title={fullUrl ? "Ctrl...

### Prompt 2

在最新的main分支上开一个分支来提交修改


# Session Context

## User Prompts

### Prompt 1

Implement the following plan:

# Fix: CLI 中 FetchURL 截断 URL 支持 Ctrl+Click 打开完整链接

## Context

Web 端直接从 `toolCall.input.url` 读取完整 URL 用于超链接，与 `primaryParam`（截断文本）分离。CLI 端应采用相同模式：从 `self._lexer`（原始 JSON）提取完整 URL，不修改 `extract_key_argument`。

## 方案

**仅修改 `src/kimi_cli/ui/shell/visualize.py`**，与 web 端 `tool.tsx` 的模式对齐。

### 修改详情

#### 新增导入
``...

### Prompt 2

这个效果不太好。不要下边的显示完整url了。仅仅显示缩略url即可，不需要考虑终端不兼容ctrl点击跳转了


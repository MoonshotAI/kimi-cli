# 平台与模型

## 平台选择

- `/setup`

::: info 参考代码
`src/kimi_cli/ui/shell/setup.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/slash.py`
:::

## Provider 类型

- `kimi`
- `openai_legacy`
- `openai_responses`
- `anthropic`
- `gemini/google_genai`
- `vertexai`

::: info 参考代码
`src/kimi_cli/llm.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/setup.py`
:::

## 模型能力与限制

- thinking
- image_in

::: info 参考代码
`src/kimi_cli/llm.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/soul/message.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/config.py`
:::

## 搜索/抓取服务

- 启用条件

::: info 参考代码
`src/kimi_cli/tools/web/search.py`, `src/kimi_cli/tools/web/fetch.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/setup.py`
:::

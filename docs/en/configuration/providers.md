# Providers and Models

## Platform selection

- `/setup`

::: info Reference Code
`src/kimi_cli/ui/shell/setup.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/slash.py`
:::

## Provider types

- `kimi`
- `openai_legacy`
- `openai_responses`
- `anthropic`
- `gemini/google_genai`
- `vertexai`

::: info Reference Code
`src/kimi_cli/llm.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/setup.py`
:::

## Model capabilities and limits

- thinking
- image_in

::: info Reference Code
`src/kimi_cli/llm.py`, `src/kimi_cli/soul/kimisoul.py`, `src/kimi_cli/soul/message.py`, `src/kimi_cli/ui/shell/prompt.py`, `src/kimi_cli/config.py`
:::

## Search and fetch services

- Enabling conditions

::: info Reference Code
`src/kimi_cli/tools/web/search.py`, `src/kimi_cli/tools/web/fetch.py`, `src/kimi_cli/config.py`, `src/kimi_cli/ui/shell/setup.py`
:::

# Environment Variables

## Kimi environment variables

- `KIMI_BASE_URL`
- `KIMI_API_KEY`
- `KIMI_MODEL_NAME`
- `KIMI_MODEL_MAX_CONTEXT_SIZE`
- `KIMI_MODEL_CAPABILITIES`
- `KIMI_MODEL_TEMPERATURE`
- `KIMI_MODEL_TOP_P`
- `KIMI_MODEL_MAX_TOKENS`

::: info Reference Code
`src/kimi_cli/utils/envvar.py`, `src/kimi_cli/config.py`, `src/kimi_cli/llm.py`
:::

## OpenAI-compatible environment variables

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`

::: info Reference Code
`src/kimi_cli/utils/envvar.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/config.py`
:::

## Other environment variables

- `KIMI_CLI_NO_AUTO_UPDATE`

::: info Reference Code
`src/kimi_cli/utils/envvar.py`, `src/kimi_cli/ui/shell/update.py`
:::

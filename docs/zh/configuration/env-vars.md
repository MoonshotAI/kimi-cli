# 环境变量

## Kimi 环境变量

- `KIMI_BASE_URL`
- `KIMI_API_KEY`
- `KIMI_MODEL_NAME`
- `KIMI_MODEL_MAX_CONTEXT_SIZE`
- `KIMI_MODEL_CAPABILITIES`
- `KIMI_MODEL_TEMPERATURE`
- `KIMI_MODEL_TOP_P`
- `KIMI_MODEL_MAX_TOKENS`

::: info 参考代码
`src/kimi_cli/utils/envvar.py`, `src/kimi_cli/config.py`, `src/kimi_cli/llm.py`
:::

## OpenAI 兼容环境变量

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`

::: info 参考代码
`src/kimi_cli/utils/envvar.py`, `src/kimi_cli/llm.py`, `src/kimi_cli/config.py`
:::

## 其他环境变量

- `KIMI_CLI_NO_AUTO_UPDATE`

::: info 参考代码
`src/kimi_cli/utils/envvar.py`, `src/kimi_cli/ui/shell/update.py`
:::

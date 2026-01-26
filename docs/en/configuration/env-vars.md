# Environment Variables

Kimi Code CLI supports overriding configuration or controlling runtime behavior through environment variables. This page lists all supported environment variables.

For detailed information on how environment variables override configuration files, see [Config Overrides](./overrides.md).

## Kimi environment variables

The following environment variables take effect when using `kimi` type providers, used to override provider and model configuration.

| Environment Variable | Description |
| --- | --- |
| `KIMI_BASE_URL` | API base URL |
| `KIMI_API_KEY` | API key |
| `KIMI_MODEL_NAME` | Model identifier |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | Maximum context length (in tokens) |
| `KIMI_MODEL_CAPABILITIES` | Model capabilities, comma-separated (e.g., `thinking,image_in`) |
| `KIMI_MODEL_TEMPERATURE` | Generation parameter `temperature` |
| `KIMI_MODEL_TOP_P` | Generation parameter `top_p` |
| `KIMI_MODEL_MAX_TOKENS` | Generation parameter `max_tokens` |

### `KIMI_BASE_URL`

Overrides the provider's `base_url` field in the configuration file.

```sh
export KIMI_BASE_URL="https://api.moonshot.cn/v1"
```

### `KIMI_API_KEY`

Overrides the provider's `api_key` field in the configuration file. Used to inject API keys without modifying the configuration file, suitable for CI/CD environments.

```sh
export KIMI_API_KEY="sk-xxx"
```

### `KIMI_MODEL_NAME`

Overrides the model's `model` field in the configuration file (the model identifier used in API calls).

```sh
export KIMI_MODEL_NAME="kimi-k2-thinking-turbo"
```

### `KIMI_MODEL_MAX_CONTEXT_SIZE`

Overrides the model's `max_context_size` field in the configuration file. Must be a positive integer.

```sh
export KIMI_MODEL_MAX_CONTEXT_SIZE="262144"
```

### `KIMI_MODEL_CAPABILITIES`

Overrides the model's `capabilities` field in the configuration file. Multiple capabilities are comma-separated, supported values are `thinking`, `always_thinking`, `image_in`, and `video_in`.

```sh
export KIMI_MODEL_CAPABILITIES="thinking,image_in"
```

### `KIMI_MODEL_TEMPERATURE`

Sets the generation parameter `temperature`, controlling output randomness. Higher values produce more random output, lower values produce more deterministic output.

```sh
export KIMI_MODEL_TEMPERATURE="0.7"
```

### `KIMI_MODEL_TOP_P`

Sets the generation parameter `top_p` (nucleus sampling), controlling output diversity.

```sh
export KIMI_MODEL_TOP_P="0.9"
```

### `KIMI_MODEL_MAX_TOKENS`

Sets the generation parameter `max_tokens`, limiting the maximum tokens per response.

```sh
export KIMI_MODEL_MAX_TOKENS="4096"
```

## OpenAI-compatible environment variables

The following environment variables take effect when using `openai_legacy` or `openai_responses` type providers.

| Environment Variable | Description |
| --- | --- |
| `OPENAI_BASE_URL` | API base URL |
| `OPENAI_API_KEY` | API key |

### `OPENAI_BASE_URL`

Overrides the provider's `base_url` field in the configuration file.

```sh
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

### `OPENAI_API_KEY`

Overrides the provider's `api_key` field in the configuration file.

```sh
export OPENAI_API_KEY="sk-xxx"
```

## Other environment variables

| Environment Variable | Description |
| --- | --- |
| `KIMI_CLI_NO_AUTO_UPDATE` | Disable automatic update check |

### `KIMI_CLI_NO_AUTO_UPDATE`

When set to `1`, `true`, `t`, `yes`, or `y` (case-insensitive), disables background auto-update check in shell mode.

```sh
export KIMI_CLI_NO_AUTO_UPDATE="1"
```

::: tip
If you installed Kimi Code CLI via Nix or other package managers, this environment variable is typically set automatically since updates are handled by the package manager.
:::

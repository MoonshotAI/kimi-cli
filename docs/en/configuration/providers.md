# Providers and Models

Kimi CLI supports multiple LLM platforms, which can be configured via configuration files or the `/setup` command.

## Platform selection

The easiest way to configure is to run the `/setup` command in shell mode and follow the wizard to select platform and model:

1. Select an API platform
2. Enter your API key
3. Select a model from the available list

After configuration, Kimi CLI will automatically save settings to `~/.kimi/config.toml` and reload.

`/setup` currently supports the following platforms:

| Platform | Description |
| --- | --- |
| Kimi for Coding | Kimi for Coding platform, supports search and fetch services |
| Moonshot AI Open Platform (moonshot.cn) | China region API endpoint |
| Moonshot AI Open Platform (moonshot.ai) | Global region API endpoint |

For other platforms, please manually edit the configuration file.

## Provider types

The `type` field in `providers` configuration specifies the API provider type. Different types use different API protocols and client implementations.

| Type | Description |
| --- | --- |
| `kimi` | Kimi API |
| `openai_legacy` | OpenAI Chat Completions API |
| `openai_responses` | OpenAI Responses API |
| `anthropic` | Anthropic Claude API |
| `gemini` | Google Gemini API |
| `vertexai` | Google Vertex AI |

### `kimi`

For connecting to Kimi API, including Kimi for Coding and Moonshot AI Open Platform.

```toml
[providers.kimi-for-coding]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-xxx"
```

### `openai_legacy`

For platforms compatible with OpenAI Chat Completions API, including the official OpenAI API and various compatible services.

```toml
[providers.openai]
type = "openai_legacy"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxx"
```

### `openai_responses`

For OpenAI Responses API (newer API format).

```toml
[providers.openai-responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxx"
```

### `anthropic`

For connecting to Anthropic Claude API.

```toml
[providers.anthropic]
type = "anthropic"
base_url = "https://api.anthropic.com"
api_key = "sk-ant-xxx"
```

### `gemini`

For connecting to Google Gemini API.

```toml
[providers.gemini]
type = "gemini"
base_url = "https://generativelanguage.googleapis.com"
api_key = "xxx"
```

### `vertexai`

For connecting to Google Vertex AI. Requires setting necessary environment variables via the `env` field.

```toml
[providers.vertexai]
type = "vertexai"
base_url = "https://xxx-aiplatform.googleapis.com"
api_key = ""
env = { GOOGLE_CLOUD_PROJECT = "your-project-id" }
```

## Model capabilities

The `capabilities` field in model configuration declares the capabilities supported by the model. This affects feature availability in Kimi CLI.

| Capability | Description |
| --- | --- |
| `thinking` | Supports thinking mode (deep reasoning) |
| `image_in` | Supports image input |
| `video_in` | Supports video input |

```toml
[models.gemini-3-pro-preview]
provider = "gemini"
model = "gemini-3-pro-preview"
max_context_size = 262144
capabilities = ["thinking", "image_in"]
```

### `thinking`

When thinking mode is enabled, the model performs deeper reasoning before answering, suitable for complex problems. In shell mode, you can toggle thinking mode with the `Tab` key, or control it at startup with `--thinking` / `--no-thinking` flags.

### `image_in`

When image input capability is enabled, you can paste images in conversations (`Ctrl-V`).

### `video_in`

When video input capability is enabled, you can send video content in conversations.

## Search and fetch services

The `SearchWeb` and `FetchURL` tools depend on external services, currently only provided by the Kimi for Coding platform.

When selecting the Kimi for Coding platform using `/setup`, search and fetch services are automatically configured.

| Service | Corresponding tool | Behavior when not configured |
| --- | --- | --- |
| `moonshot_search` | `SearchWeb` | Tool unavailable |
| `moonshot_fetch` | `FetchURL` | Falls back to local fetching |

When using other platforms, the `FetchURL` tool is still available but will fall back to local fetching.

# Platforms and models

Kimi Code CLI supports multiple LLM platforms and can be configured via configuration files or the `/login` command.

## Platform selection

The simplest way to configure is to run the `/login` command (alias `/setup`) in Shell mode and follow the wizard to complete platform and model selection:

1. Select API platform
2. Enter API key
3. Select a model from the available models list

After configuration is complete, Kimi Code CLI will automatically save the settings to `~/.kimi/config.toml` and reload.

`/login` currently supports the following platforms:

| Platform | Description |
| --- | --- |
| Kimi Code | Kimi Code platform, supports search and fetch services |
| Moonshot AI Open Platform (moonshot.cn) | China region API endpoint |
| Moonshot AI Open Platform (moonshot.ai) | Global region API endpoint |

To use other platforms, please manually edit the configuration file.

## Provider types

The `type` field in the `providers` configuration specifies the API provider type. Different types use different API protocols and client implementations.

| Type | Description |
| --- | --- |
| `kimi` | Kimi API |
| `openai_legacy` | OpenAI Chat Completions API |
| `openai_responses` | OpenAI Responses API |
| `anthropic` | Anthropic Claude API |
| `gemini` | Google Gemini API |
| `vertexai` | Google Vertex AI |

### `kimi`

Used to connect to the Kimi API, including Kimi Code and Moonshot AI Open Platform.

```toml
[providers.kimi-for-coding]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-xxx"
```

### `openai_legacy`

Platforms compatible with the OpenAI Chat Completions API, including the official OpenAI API and various compatible services.

```toml
[providers.openai]
type = "openai_legacy"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxx"
```

### `openai_responses`

Used for the OpenAI Responses API (newer API format).

```toml
[providers.openai-responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxx"
```

### `anthropic`

Used to connect to the Anthropic Claude API.

```toml
[providers.anthropic]
type = "anthropic"
base_url = "https://api.anthropic.com"
api_key = "sk-ant-xxx"
```

### `gemini`

Used to connect to the Google Gemini API.

```toml
[providers.gemini]
type = "gemini"
base_url = "https://generativelanguage.googleapis.com"
api_key = "xxx"
```

### `vertexai`

Used to connect to Google Vertex AI. Requires setting necessary environment variables via the `env` field.

```toml
[providers.vertexai]
type = "vertexai"
base_url = "https://xxx-aiplatform.googleapis.com"
api_key = ""
env = { GOOGLE_CLOUD_PROJECT = "your-project-id" }
```

## Model capabilities

The `capabilities` field in the model configuration declares the capabilities supported by the model. This affects the availability of Kimi Code CLI features.

| Capability | Description |
| --- | --- |
| `thinking` | Supports Thinking mode (deep thinking), can be toggled on/off |
| `always_thinking` | Always uses Thinking mode (cannot be turned off) |
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

Declares that the model supports Thinking mode. When enabled, the model will perform deeper reasoning before answering, suitable for complex problems. In Shell mode, you can switch models and Thinking mode via the `/model` command, or control it at startup via the `--thinking` / `--no-thinking` parameters.

### `always_thinking`

Indicates that the model always uses Thinking mode and cannot be turned off. For example, models with "thinking" in their name, such as `kimi-k2-thinking-turbo`, typically have this capability. When using such models, the `/model` command will not prompt you to select the Thinking mode toggle.

### `image_in`

After enabling the image input capability, you can paste images (`Ctrl-V`) in the conversation.

### `video_in`

After enabling the video input capability, you can send video content in the conversation.

## Search and fetch services

The `SearchWeb` and `FetchURL` tools depend on external services, currently only provided by the Kimi Code platform.

When using `/login` to select the Kimi Code platform, search and fetch services are automatically configured.

| Service | Corresponding tool | Behavior when not configured |
| --- | --- | --- |
| `moonshot_search` | `SearchWeb` | Tool unavailable |
| `moonshot_fetch` | `FetchURL` | Falls back to local fetch |

When using other platforms, the `FetchURL` tool is still available but will fall back to local fetch.

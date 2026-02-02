# Configuration overrides

Kimi Code CLI configuration can be set through multiple methods, with different configuration sources overriding each other based on priority.

## Priority

Configuration priority from high to low:

1. **Environment variables** - Highest priority, used for temporary overrides or CI/CD environments
2. **CLI arguments** - Parameters specified at startup
3. **Configuration file** - `~/.kimi/config.toml` or file specified via `--config-file`

## CLI arguments

### Configuration file related

| Argument | Description |
| --- | --- |
| `--config <TOML/JSON>` | Pass configuration content directly, overriding the default config file |
| `--config-file <PATH>` | Specify configuration file path, replacing the default `~/.kimi/config.toml` |

`--config` and `--config-file` cannot be used simultaneously.

### Model related

| Argument | Description |
| --- | --- |
| `--model, -m <NAME>` | Specify the model name to use |

The model specified by `--model` must be defined in the configuration file's `models`. If not specified, the `default_model` from the configuration file is used.

### Behavior related

| Argument | Description |
| --- | --- |
| `--thinking` | Enable thinking mode |
| `--no-thinking` | Disable thinking mode |
| `--yolo, --yes, -y` | Auto-approve all actions |

`--thinking` / `--no-thinking` will override the thinking state saved from the last session. If not specified, the state from the last session is used.

## Environment variable overrides

Environment variables can override provider and model settings without modifying the configuration file. This is particularly useful in the following scenarios:

- Injecting secrets in CI/CD environments
- Temporarily testing different API endpoints
- Switching between multiple environments

Environment variables take effect based on the type of provider currently in use:

- `kimi` type providers: use `KIMI_*` environment variables
- `openai_legacy` or `openai_responses` type providers: use `OPENAI_*` environment variables
- Other types of providers: environment variable overrides not supported

For a complete list of environment variables, please refer to [Environment variables](./env-vars.md).

Example:

```sh
KIMI_API_KEY="sk-xxx" KIMI_MODEL_NAME="kimi-k2-thinking-turbo" kimi
```

## Configuration priority examples

Assuming the configuration file `~/.kimi/config.toml` contains the following:

```toml
default_model = "kimi-for-coding"

[providers.kimi-for-coding]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-config"

[models.kimi-for-coding]
provider = "kimi-for-coding"
model = "kimi-for-coding"
max_context_size = 262144
```

Here are the configuration sources for different scenarios:

| Scenario | `base_url` | `api_key` | `model` |
| --- | --- | --- | --- |
| `kimi` | Config file | Config file | Config file |
| `KIMI_API_KEY=sk-env kimi` | Config file | Environment variable | Config file |
| `kimi --model other` | Config file | Config file | CLI argument |
| `KIMI_MODEL_NAME=k2 kimi` | Config file | Config file | Environment variable |

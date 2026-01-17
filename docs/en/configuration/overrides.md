# Config Overrides

Gitrekt CLI configuration can be set through multiple methods, with different sources overriding each other by priority.

## Priority

Configuration priority from highest to lowest:

1. **Environment variables** - Highest priority, for temporary overrides or CI/CD environments
2. **CLI flags** - Flags specified at startup
3. **Configuration file** - `~/.Gitrekt/config.toml` or file specified via `--config-file`

## CLI flags

### Configuration file related

| Flag | Description |
| --- | --- |
| `--config <TOML/JSON>` | Pass configuration content directly, overrides default config file |
| `--config-file <PATH>` | Specify configuration file path, replaces default `~/.Gitrekt/config.toml` |

`--config` and `--config-file` cannot be used together.

### Model related

| Flag | Description |
| --- | --- |
| `--model, -m <NAME>` | Specify model name to use |

The model specified by `--model` must be defined in the configuration file's `models`. If not specified, uses `default_model` from the configuration file.

### Behavior related

| Flag | Description |
| --- | --- |
| `--thinking` | Enable thinking mode |
| `--no-thinking` | Disable thinking mode |
| `--yolo, --yes, -y` | Auto-approve all operations |

`--thinking` / `--no-thinking` overrides the thinking state saved from the last session. If not specified, uses the last session's state.

## Environment variable overrides

Environment variables can override provider and model settings without modifying the configuration file. This is particularly useful in the following scenarios:

- Injecting keys in CI/CD environments
- Temporarily testing different API endpoints
- Switching between multiple environments

Environment variables take effect based on the current provider type:

- `Gitrekt` type providers: Use `GITREKT_*` environment variables
- `openai_legacy` or `openai_responses` type providers: Use `OPENAI_*` environment variables
- Other provider types: Environment variable overrides not supported

See [Environment Variables](./env-vars.md) for the complete list.

Example:

```sh
GITREKT_API_KEY="sk-xxx" GITREKT_MODEL_NAME="Gitrekt-k2-thinking-turbo" Gitrekt
```

## Configuration priority example

Assume the configuration file `~/.Gitrekt/config.toml` contains:

```toml
default_model = "Gitrekt-for-coding"

[providers.Gitrekt-for-coding]
type = "Gitrekt"
base_url = "https://api.Gitrekt.com/coding/v1"
api_key = "sk-config"

[models.Gitrekt-for-coding]
provider = "Gitrekt-for-coding"
model = "Gitrekt-for-coding"
max_context_size = 262144
```

Here are the configuration sources in different scenarios:

| Scenario | `base_url` | `api_key` | `model` |
| --- | --- | --- | --- |
| `Gitrekt` | Config file | Config file | Config file |
| `GITREKT_API_KEY=sk-env Gitrekt` | Config file | Environment variable | Config file |
| `Gitrekt --model other` | Config file | Config file | CLI flag |
| `GITREKT_MODEL_NAME=k2 Gitrekt` | Config file | Config file | Environment variable |

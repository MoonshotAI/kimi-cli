# 环境变量

Kimi Code CLI 支持通过环境变量覆盖配置或控制运行行为。本页列出所有支持的环境变量。

关于环境变量如何覆盖配置文件的详细说明，请参阅 [配置覆盖](./overrides.md)。

## Kimi 环境变量

以下环境变量在使用 `kimi` 类型的供应商时生效，用于覆盖供应商和模型配置。

| 环境变量 | 说明 |
| --- | --- |
| `KIMI_BASE_URL` | API 基础 URL |
| `KIMI_API_KEY` | API 密钥 |
| `KIMI_MODEL_NAME` | 模型标识符 |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | 最大上下文长度（token 数） |
| `KIMI_MODEL_CAPABILITIES` | 模型能力，逗号分隔（如 `thinking,image_in`） |
| `KIMI_MODEL_TEMPERATURE` | 生成参数 `temperature` |
| `KIMI_MODEL_TOP_P` | 生成参数 `top_p` |
| `KIMI_MODEL_MAX_TOKENS` | 生成参数 `max_tokens` |

### `KIMI_BASE_URL`

覆盖配置文件中供应商的 `base_url` 字段。

```sh
export KIMI_BASE_URL="https://api.moonshot.cn/v1"
```

### `KIMI_API_KEY`

覆盖配置文件中供应商的 `api_key` 字段。用于在不修改配置文件的情况下注入 API 密钥，适合 CI/CD 环境。

```sh
export KIMI_API_KEY="sk-xxx"
```

### `KIMI_MODEL_NAME`

覆盖配置文件中模型的 `model` 字段（API 调用时使用的模型标识符）。

```sh
export KIMI_MODEL_NAME="kimi-k2-thinking-turbo"
```

### `KIMI_MODEL_MAX_CONTEXT_SIZE`

覆盖配置文件中模型的 `max_context_size` 字段。必须是正整数。

```sh
export KIMI_MODEL_MAX_CONTEXT_SIZE="262144"
```

### `KIMI_MODEL_CAPABILITIES`

覆盖配置文件中模型的 `capabilities` 字段。多个能力用逗号分隔，支持的值为 `thinking`、`always_thinking`、`image_in` 和 `video_in`。

```sh
export KIMI_MODEL_CAPABILITIES="thinking,image_in"
```

### `KIMI_MODEL_TEMPERATURE`

设置生成参数 `temperature`，控制输出的随机性。值越高输出越随机，值越低输出越确定。

```sh
export KIMI_MODEL_TEMPERATURE="0.7"
```

### `KIMI_MODEL_TOP_P`

设置生成参数 `top_p`（nucleus sampling），控制输出的多样性。

```sh
export KIMI_MODEL_TOP_P="0.9"
```

### `KIMI_MODEL_MAX_TOKENS`

设置生成参数 `max_tokens`，限制单次回复的最大 token 数。

```sh
export KIMI_MODEL_MAX_TOKENS="4096"
```

## OpenAI 兼容环境变量

以下环境变量在使用 `openai_legacy` 或 `openai_responses` 类型的供应商时生效。

| 环境变量 | 说明 |
| --- | --- |
| `OPENAI_BASE_URL` | API 基础 URL |
| `OPENAI_API_KEY` | API 密钥 |

### `OPENAI_BASE_URL`

覆盖配置文件中供应商的 `base_url` 字段。

```sh
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

### `OPENAI_API_KEY`

覆盖配置文件中供应商的 `api_key` 字段。

```sh
export OPENAI_API_KEY="sk-xxx"
```

## 其他环境变量

| 环境变量 | 说明 |
| --- | --- |
| `KIMI_SHARE_DIR` | 自定义共享目录路径（默认 `~/.kimi`） |
| `KIMI_CLI_NO_AUTO_UPDATE` | 禁用自动更新检查 |

### `KIMI_SHARE_DIR`

自定义 Kimi Code CLI 的共享目录路径。默认路径为 `~/.kimi`，配置、会话、日志等运行时数据存储在此目录下。

```sh
export KIMI_SHARE_DIR="/path/to/custom/kimi"
```

详见 [数据路径](./data-locations.md)。

::: warning 注意
`KIMI_SHARE_DIR` 不影响 [Agent Skills](../customization/skills.md) 的搜索路径。Skills 是跨工具共享的能力扩展（与 Claude、Codex 等兼容），与应用运行时数据是不同类型的数据。如需覆盖 Skills 路径，请使用 `--skills-dir` 参数。
:::

### `KIMI_CLI_NO_AUTO_UPDATE`

设置为 `1`、`true`、`t`、`yes` 或 `y`（不区分大小写）时，禁用 Shell 模式下的后台自动更新检查。

```sh
export KIMI_CLI_NO_AUTO_UPDATE="1"
```

::: tip 提示
如果你通过 Nix 或其他包管理器安装 Kimi Code CLI，通常会自动设置此环境变量，因为更新由包管理器处理。
:::


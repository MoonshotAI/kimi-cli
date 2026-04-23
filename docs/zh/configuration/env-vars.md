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
| `KIMI_MODEL_THINKING_KEEP` | Moonshot `thinking.keep` 开关（Preserved Thinking），仅在 Thinking 模式下生效 |

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

### `KIMI_MODEL_THINKING_KEEP`

将 env 值原样作为 `thinking.keep` 字段发送给 Moonshot API，用于开启 Preserved Thinking（参考 [Moonshot 官方文档](https://platform.kimi.com/docs/guide/use-kimi-k2-thinking-model#preserved-thinking)）。设为 `all` 可让模型在多轮之间保留历史 reasoning_content。值不做任何校验、不做大小写归一化，透传给 API 自己判断。

```sh
export KIMI_MODEL_THINKING_KEEP="all"
```

未设置或设为空字符串时，请求体不携带此字段（等同当前默认行为）。该覆盖仅在当前模型真正处于 Thinking 模式时生效；对非 Thinking 模式的调用会被忽略，以避免发出只有 `thinking.keep` 而缺少 `thinking.type` 的无效请求体。

此参数仅在支持 Preserved Thinking 的 Moonshot 模型（例如 `kimi-k2.6` / `kimi-k2-thinking`）上生效。传给其它模型时，Moonshot API 会忽略或拒绝该字段，CLI 本身不做校验。

::: warning 注意成本
`thinking.keep=all` 会让 API 在多轮之间保留历史 reasoning_content，input tokens 与 API 费用都会显著增加。请在确实需要 Preserved Thinking 时再开启。
:::

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
| `KIMI_CLI_NO_AUTO_UPDATE` | 禁用所有更新相关功能 |
| `KIMI_CLI_PASTE_CHAR_THRESHOLD` | 粘贴文本折叠的字符数阈值（默认 `1000`） |
| `KIMI_CLI_PASTE_LINE_THRESHOLD` | 粘贴文本折叠的行数阈值（默认 `15`） |

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

设置为 `1`、`true`、`t`、`yes` 或 `y`（不区分大小写）时，禁用所有更新相关功能，包括后台自动更新检查、启动时的阻断式更新提醒和欢迎面板中的版本提示。

```sh
export KIMI_CLI_NO_AUTO_UPDATE="1"
```

::: tip 提示
如果你通过 Nix 或其他包管理器安装 Kimi Code CLI，通常会自动设置此环境变量，因为更新由包管理器处理。
:::

### `KIMI_CLI_PASTE_CHAR_THRESHOLD`

在 Agent 模式下，当粘贴文本的字符数达到此阈值时，文本会被折叠为占位符（如 `[Pasted text #1 +10 lines]`）显示，提交时自动展开为完整内容。默认值为 `1000`。

```sh
export KIMI_CLI_PASTE_CHAR_THRESHOLD="1000"
```

### `KIMI_CLI_PASTE_LINE_THRESHOLD`

在 Agent 模式下，当粘贴文本的行数达到此阈值时，文本会被折叠为占位符显示。默认值为 `15`。

```sh
export KIMI_CLI_PASTE_LINE_THRESHOLD="15"
```

::: tip 提示
部分终端（如通过 SSH 连接的 XShell）在粘贴多行文本后，可能出现中文/日文/韩文等 CJK 输入法无法正常工作的问题，表现为 IME 候选窗口不弹出或输入无响应，需要按 Ctrl+C 后才能恢复。

这是因为多行文本在输入缓冲区中会导致终端光标定位信息错乱，影响 IME 的组合窗口定位。你可以通过降低行数阈值来规避此问题——将包含换行的粘贴内容折叠为单行占位符：

```sh
export KIMI_CLI_PASTE_LINE_THRESHOLD="2"
```

设置后，任何包含换行的粘贴内容都会被自动折叠，避免多行文本进入输入缓冲区。单行粘贴（如 URL、短命令）不受影响。

注意：两个阈值的判断逻辑是"满足任一即折叠"（字符数 **或** 行数），因此只需调低行数阈值即可。不建议将字符数阈值设为很小的值（如 `1`），否则所有非空粘贴（包括单行短文本）都会被折叠。
:::


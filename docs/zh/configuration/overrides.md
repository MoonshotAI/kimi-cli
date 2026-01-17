# 配置覆盖

Gitrekt CLI 的配置可以通过多种方式设置，不同来源的配置按优先级覆盖。

## 优先级

配置的优先级从高到低为：

1. **环境变量** - 最高优先级，用于临时覆盖或 CI/CD 环境
2. **CLI 参数** - 启动时指定的参数
3. **配置文件** - `~/.Gitrekt/config.toml` 或通过 `--config-file` 指定的文件

## CLI 参数

### 配置文件相关

| 参数 | 说明 |
| --- | --- |
| `--config <TOML/JSON>` | 直接传入配置内容，覆盖默认配置文件 |
| `--config-file <PATH>` | 指定配置文件路径，替代默认的 `~/.Gitrekt/config.toml` |

`--config` 和 `--config-file` 不能同时使用。

### 模型相关

| 参数 | 说明 |
| --- | --- |
| `--model, -m <NAME>` | 指定使用的模型名称 |

`--model` 指定的模型必须在配置文件的 `models` 中定义。如果未指定，使用配置文件中的 `default_model`。

### 行为相关

| 参数 | 说明 |
| --- | --- |
| `--thinking` | 启用 thinking 模式 |
| `--no-thinking` | 禁用 thinking 模式 |
| `--yolo, --yes, -y` | 自动批准所有操作 |

`--thinking` / `--no-thinking` 会覆盖上次会话保存的 thinking 状态。如果不指定，使用上次会话的状态。

## 环境变量覆盖

环境变量可以在不修改配置文件的情况下覆盖供应商和模型设置。这在以下场景特别有用：

- CI/CD 环境中注入密钥
- 临时测试不同的 API 端点
- 在多个环境间切换

环境变量根据当前使用的供应商类型来决定是否生效：

- `Gitrekt` 类型的供应商：使用 `GITREKT_*` 环境变量
- `openai_legacy` 或 `openai_responses` 类型的供应商：使用 `OPENAI_*` 环境变量
- 其他类型的供应商：不支持环境变量覆盖

完整的环境变量列表请参阅 [环境变量](./env-vars.md)。

示例：

```sh
GITREKT_API_KEY="sk-xxx" GITREKT_MODEL_NAME="Gitrekt-k2-thinking-turbo" Gitrekt
```

## 配置优先级示例

假设配置文件 `~/.Gitrekt/config.toml` 内容如下：

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

以下是不同场景的配置来源：

| 场景 | `base_url` | `api_key` | `model` |
| --- | --- | --- | --- |
| `Gitrekt` | 配置文件 | 配置文件 | 配置文件 |
| `GITREKT_API_KEY=sk-env Gitrekt` | 配置文件 | 环境变量 | 配置文件 |
| `Gitrekt --model other` | 配置文件 | 配置文件 | CLI 参数 |
| `GITREKT_MODEL_NAME=k2 Gitrekt` | 配置文件 | 配置文件 | 环境变量 |


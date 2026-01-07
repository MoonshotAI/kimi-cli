---
Author: @codex
Updated: 2026-01-07
Status: Draft
---

# KLIP-6: /setup 平台模型自动刷新与托管命名空间

## 背景与现状（最终实现）

* `/setup` 位于 `src/kimi_cli/ui/shell/setup.py`：选择平台、输入 API key、调用 `list_models(platform, api_key)` 获取并过滤模型，然后写入 `config.providers` 与 `config.models`，并设置 `default_model` 为用户选中的模型。
* `Config` 定义在 `src/kimi_cli/config.py`：`providers` 与 `models` 平级，`default_model` 必须指向 `models` 中的键，且每个 `LLMModel.provider` 必须存在于 `providers`。
* `/setup` 使用托管命名空间（`managed:`）写入 provider/model，避免覆盖用户自定义配置。

## 目标

* 在 `/model` 斜杠命令触发时自动刷新 `/setup` 所配置平台的模型列表，并写回配置文件。
* 自动刷新只覆盖“/setup 管理的模型”，不影响用户自行配置的 provider/model。
* 保持 CLI 可用性：默认模型仍可正常加载，`/model` 列表可用。
* 适用于所有启动方式：只要使用 `/model` 命令且配置中存在 `/setup` 托管 provider，并且使用默认配置文件位置，才会自动刷新。

## 设计概览

### 1) 托管命名空间（区分自动管理与用户自定义）

为 `/setup` 管理的 provider/model 引入保留命名空间，避免和用户配置冲突：

* provider key：`managed:<platform-id>`
* model key：`<platform-id>/<model-id>`

模型条目仍保留真实 `model` 字段（API 端模型名），`provider` 字段指向上述 provider key。

示例：

```toml
[providers."managed:moonshot-cn"]
type = "kimi"
base_url = "https://api.moonshot.cn/v1"
api_key = "sk-xxx"

[models."moonshot-cn/kimi-k2-thinking-turbo"]
provider = "managed:moonshot-cn"
model = "kimi-k2-thinking-turbo"
max_context_size = 262144
```

这样可以做到：

* `/setup` 管理的模型可以被“强制覆盖”。
* 用户仍可自由定义 `providers.moonshot-cn`、`models.kimi-k2-thinking-turbo` 等同名项，不会被覆盖。

### 2) 识别“/setup 平台”的最小信息源

将 `/setup` 平台清单抽到公共模块（例如 `src/kimi_cli/platforms.py`），提供：

* `id`、`name`、`base_url`
* `search_url`、`fetch_url`（可选）
* `allowed_prefixes`（过滤模型前缀）

`/setup` 与自动刷新都基于同一份平台定义。

### 3) 自动刷新机制（/model 触发）

在 `/model` 命令（`src/kimi_cli/ui/shell/slash.py`）触发刷新逻辑，仅在默认配置文件位置时启用：

1. 仅当 `config.is_from_default_location` 为真时继续，否则直接跳过刷新。
2. 扫描 `providers` 中以 `managed:` 开头的条目，视为托管平台；若没有托管 provider，则不刷新。
3. 对每个平台调用 `{base_url}/models`，并在 `list_models` 内按 `allowed_prefixes` 过滤。
4. 生成/更新 `models` 中对应的 `<platform-id>/...` 条目：
   * 更新 `max_context_size`
   * 移除已经下线的模型条目
5. 若发生变化：写回 config 文件，并同步更新内存中的 `runtime.config`，使 `/model` 立即可见。

写回策略：

* 自动刷新仅在默认配置路径启用，因此写回总是落到默认 config 文件。
* 非默认配置（`--config` / `--config-file`）不会触发自动刷新。

错误处理：网络/鉴权失败时记录日志并跳过该平台，`/model` 继续展示已有配置。

### 4) `/setup` 行为调整

`/setup` 写入配置时使用托管命名空间，并写入全部过滤后的模型：

* provider：`managed:<platform-id>`
* model：`<platform-id>/<model-id>`
* 将过滤后的模型全量写入 `models`（同一 provider 下旧模型先清理）
* `default_model` 指向托管 model key（用户选择的模型 `selected_model_id`）
* `services.moonshot_search` / `services.moonshot_fetch` 保持现有行为

### 5) UI 展示优化（可选）

`/model` 列表可以显示更友好的 label：

* 显示 `model.model` 作为主名字
* 将 `managed:` 的 provider 显示为平台名（直接使用 `Platform.name`）
* 选择时仍用真实 key，避免破坏现有逻辑
* 说明：`/model` 的持久切换只在默认配置文件可写时生效（现有约束），与“仅默认位置自动刷新”的策略一致

## 迁移策略（不做）

为了保持简单与低风险，不做任何自动迁移。仅对通过新版 `/setup` 写入的托管 provider/model 生效。

## 兼容性与边界

* 如果用户显式使用 `--config`（字符串）或 `--config-file` 指定文件，自动刷新不会触发。
* 若 `default_model` 指向的托管模型被 API 下线，自动回退到该平台列表中的第一个模型。
* 仅影响 `/setup` 平台；自定义 provider/model 不受影响。

## 实施步骤（建议）

1. 抽出平台定义模块，供 `/setup` 与自动刷新共享。
2. 调整 `/setup` 写入逻辑（命名空间 + default_model）。
3. 在 `/model` 触发自动刷新逻辑。
4. `/model` 展示逻辑优化（仅 UI 层）。
5. （可选）测试覆盖刷新与写入逻辑。

## 关键参考位置

* `/setup`：`src/kimi_cli/ui/shell/setup.py`
* 配置结构：`src/kimi_cli/config.py`
* 平台与模型刷新：`src/kimi_cli/platforms.py`
* `/model`：`src/kimi_cli/ui/shell/slash.py`

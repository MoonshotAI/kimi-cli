---
Author: "@stdrc"
Updated: 2026-01-14
Status: Draft
---

# KLIP-11: Kimi Code OAuth /login

## 背景与现状

* `/setup` 位于 `src/kimi_cli/ui/shell/setup.py`：选择平台 -> 输入 API key -> 拉取模型 ->
  写入 `config.providers` / `config.models` / `default_model`，并在 Kimi Code 平台时自动配置
  `services.moonshot_search` / `services.moonshot_fetch`。
* Kimi Code 平台在 `src/kimi_cli/platforms.py` 中定义，`base_url` 为
  `https://api.kimi.com/coding/v1`。
* 现有配置以 API key 作为 `Authorization: Bearer <api_key>`，`/usage` 也依赖该 Bearer。

## 目标

* 为 Kimi Code 平台提供基于 OAuth 的 `/login` 斜杠命令，替代手动 API key 输入。
* OAuth 流程标准化：Authorization Code + PKCE（优先），支持无回调时的手动拷贝 code。
* 登录成功后与 `/setup` 一致：拉取模型、写入托管 provider/model、设置默认模型和
  search/fetch 服务。
* Token 可自动刷新，过期后尽量无感恢复。

## 非目标

* 不支持 Moonshot Open Platform 等其他平台。
* 不替代 `/setup` 或移除 API key 方案。
* 不实现完整账户管理或多账号切换。

## 设计概览

### 1) Kimi Code OAuth 端点与要求

Kimi Code 需要提供标准 OAuth 2.0 端点（建议 OIDC discovery），并注册一个 CLI 公共客户端：

* OAuth client（public）：
  * `client_id`: e.g. `kimi-cli`
  * 不需要 client secret
  * 允许 loopback redirect URI（见下）
* 端点（优先通过 discovery 获取）：
  * `authorization_endpoint`
  * `token_endpoint`
  * `revocation_endpoint`（可选）
  * `device_authorization_endpoint`（可选，若支持 device code）
* Scope 建议包含：
  * `coding`（或等价 API scope）
  * `offline_access`（获取 refresh_token）

建议 discovery URL（待确认）：

* `https://kimi.com/.well-known/openid-configuration`
* 或 `https://kimi.com/coding/.well-known/openid-configuration`

若不支持 discovery，则需在 CLI 内部固定以下端点（示例占位，需后端确认）：

* `https://kimi.com/oauth/authorize`
* `https://api.kimi.com/oauth/token`

### 2) /login UX 流程

1. `/login` 仅支持 Kimi Code 平台，直接进入授权流程（不再提示平台选择）。
2. 生成 `state`、`code_verifier`、`code_challenge`，启动本地 loopback 监听。
3. 构造授权 URL，调用 `webbrowser.open` 打开；失败则打印 URL 并提示用户复制打开。
4. 回调成功 -> 用 `code` 换 token；回调超时 -> 提示用户从浏览器地址栏复制 `code`。
5. 用 access_token 调用 `list_models` 并让用户选择默认模型（流程同 `/setup`）。
6. 写回 `config.toml`（托管 provider + models + services），保存 OAuth token 信息。
7. 触发 `Reload` 以重新加载 LLM。

### 3) 浏览器打开的 URL

示例（参数名与 OAuth 标准一致）：

```
{authorization_endpoint}?
  response_type=code&
  client_id=kimi-cli&
  redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Foauth%2Fcallback&
  scope=coding%20offline_access&
  code_challenge=...&
  code_challenge_method=S256&
  state=...
```

### 4) Callback 与手动 code

* 默认使用 loopback 回调：`http://127.0.0.1:{port}/oauth/callback`
  * `port` 为随机可用端口
  * 回调校验 `state`
  * 返回简单 HTML 提示“可以关闭窗口”
* 若回调失败或无法启动本地监听：
  * CLI 提示用户从浏览器地址栏复制 `code` 参数
  * CLI 继续完成 token exchange

### 5) Token 存储方案

为了最小化改动，保持 access_token 作为 provider api_key，并在 provider 上增加 oauth 元信息：

* `providers."managed:kimi-code".api_key` = access_token
* `providers."managed:kimi-code".oauth`（新增字段）：
  * `refresh_token`
  * `expires_at`（epoch seconds）
  * `scope`
  * `token_type`

同时将 search/fetch 的 `api_key` 与 access_token 保持同步。

示例：

```toml
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "at-xxx"
oauth = { refresh_token = "rt-xxx", expires_at = 1760000000, scope = "coding offline_access" }

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = "at-xxx"
```

### 6) Token 刷新策略

* 启动时或每次创建 LLM 之前检查 `expires_at`：
  * 若剩余时间 < 5 分钟，先刷新
* 刷新流程：
  * `grant_type=refresh_token`
  * `refresh_token`, `client_id`
* 刷新成功：
  * 更新 `api_key` 与 `oauth.expires_at`
  * 同步更新 search/fetch 的 `api_key`
  * 触发 `Reload` 以重建 LLM
* 刷新失败：
  * 提示用户重新 `/login`

### 7) 与 /setup 的关系

* `/setup` 仍保留 API key 交互，OAuth 仅通过 `/login`。
* `/login` 使用与 `/setup` 相同的托管命名空间：
  * provider key: `managed:kimi-code`
  * model key: `kimi-code/<model-id>`
* 可选：未来在 `/setup` 中提供 “Login with browser (OAuth)” 入口，但非本次目标。

## 边界与兼容性

* 如果用户使用 `--config` / `--config-file`，当前 `/setup` 仍会写默认配置；
  `/login` 建议同样遵循默认配置策略。
* 仅当 access_token 可用于 `base_url`、`search_url`、`fetch_url` 时才自动开启服务；
  否则只写 LLM provider，不写 `services`。
* OAuth 模型和 API 兼容性与当前 Bearer key 完全一致。

## 待确认事项

* `kimi.com/code` 与 `kimi.com/coding` 的实际入口与 OAuth 授权页面 URL。
* OAuth 端点的真实路径或 discovery URL。
* Kimi Code 支持的 scope 命名与是否支持 refresh_token。
* 是否支持 device authorization grant（可作为更友好的 CLI 备选）。

## 关键参考位置

* `/setup` 入口：`src/kimi_cli/ui/shell/setup.py`
* 平台定义：`src/kimi_cli/platforms.py`
* 配置结构：`src/kimi_cli/config.py`
* Kimi provider：`packages/kosong/src/kosong/chat_provider/kimi.py`

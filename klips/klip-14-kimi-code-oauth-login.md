---
Author: "@stdrc"
Updated: 2026-01-24
Status: Implemented
---

# KLIP-14: Kimi Code OAuth /login

## 背景与现状

* `/setup` 位于 `src/kimi_cli/ui/shell/setup.py`：选择平台 -> 输入 API key -> 拉取模型 ->
  写入 `config.providers` / `config.models` / `default_model`，并在 Kimi Code 平台时自动配置
  `services.moonshot_search` / `services.moonshot_fetch`。
* Kimi Code 平台在 `src/kimi_cli/auth/platforms.py` 中定义，`base_url` 为
  `https://api.kimi.com/coding/v1`。
* 现有配置以 API key 作为 `Authorization: Bearer <api_key>`，`/usage` 也依赖该 Bearer。

## 目标

* 为 Kimi Code 平台提供基于 OAuth 的 `/login` 斜杠命令，替代手动 API key 输入。
* 提供 `/logout` 与 `kimi logout`，清理 OAuth 凭据并撤销本地授权状态。
* OAuth 流程基于 Device Authorization Grant（后端现有实现），CLI 轮询 token
  endpoint 获取 access_token；如后续支持，可扩展为 Authorization Code + PKCE。
* 登录成功后与 `/setup` 一致：拉取模型、写入托管 provider/model、设置默认模型和
  search/fetch 服务。
* Token 可自动刷新，过期后尽量无感恢复。

## 非目标

* 不支持 Moonshot Open Platform 等其他平台。
* 不替代 `/setup` 或移除 API key 方案。
* 不实现完整账户管理或多账号切换。

## 设计概览

### 1) Kimi Code OAuth 端点与要求（Device Authorization Grant）

后端当前提供 Device Authorization Grant（RFC 8628），CLI 需要对接实际端点：

* OAuth host（可配置）：
  * 默认：`https://auth.kimi.com`
  * 可用环境变量覆盖：`KIMI_CODE_OAUTH_HOST` 或 `KIMI_OAUTH_HOST`
* Public client：
  * `client_id`: `17e5f671-d194-4dfb-9706-5516cb48c098`
  * 不需要 client secret
* 端点：
  * `POST /api/oauth/device_authorization`
  * `POST /api/oauth/token`（device_code + refresh_token）
* Scope（若后端要求）：
  * 当前实现仅发送 `client_id`，未携带 scope
* 典型返回字段：
  * `user_code` / `device_code`
  * `verification_uri` / `verification_uri_complete`
  * `expires_in` / `interval`

**请求头（真实后端要求）**

所有 token 相关请求需要附带设备信息头（示例值按实际环境生成）：

```python
from kimi_cli.constant import VERSION
import platform
import socket

COMMON_HEADERS = {
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": VERSION,
    "X-Msh-Device-Name": platform.node() or socket.gethostname(),
    "X-Msh-Device-Model": "<os-name + version + arch>",
    "X-Msh-Os-Version": platform.version(),
    "X-Msh-Device-Id": "<stable-uuid>",
}
```

* `X-Msh-Platform` 固定为 `kimi_cli`。
* `X-Msh-Version` 使用 `kimi_cli.constant.VERSION`（实际版本号）。
* `X-Msh-Device-Name` 使用设备名（`platform.node()` / `socket.gethostname()`）。
* `X-Msh-Device-Model` 使用系统名 + 版本号 + 架构（如 `Windows 11 AMD64`、
  `macOS 15.1.1 arm64`）。
* `X-Msh-Os-Version` 使用 `platform.version()`（与 `Environment.os_version` 一致）。
* `X-Msh-Device-Id` 为稳定 UUID，首次生成后持久化，建议存放于 `~/.kimi/device_id`
  并设置权限 `0600`。

### 2) /login UX 流程

1. `/login` 与 `kimi login` 仅支持 Kimi Code 平台；若不是默认 config location 则直接拒绝。
2. `POST /api/oauth/device_authorization` 获取 `verification_uri_complete` 与 `user_code`。
3. 直接 `webbrowser.open(verification_uri_complete)`，同时打印 Verification URL
   （`verification_uri_complete` 通常已包含 user_code）。
4. 按 `interval` 轮询 `POST /api/oauth/token`，
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`。
   * 仅特判 `expired_token` -> 重新发起 `/login`
   * 其他错误 -> 继续按 interval 等待（不特殊处理 `slow_down`）
5. 交换成功 -> 保存 tokens，拉取模型，写入托管 provider/model，设置默认模型和
   search/fetch 服务（流程同 `/setup`），access_token 同时用于 LLM/search/fetch。
6. Shell `/login` 成功后触发 `Reload`；`kimi login` 仅执行登录流程并退出。

### 3) 用户授权提示

CLI 提示用户打开浏览器并输入 user code，不再需要本地回调或手动拷贝 code：

```
Please visit the following URL and enter the user code to authorize:
Verification URL: {verification_uri_complete}
```

注意：`ApproveDeviceGrant` 是 Web 侧的审批接口，仅用于测试，CLI 不应调用。

### 4) /logout UX 流程

1. `/logout` 与 `kimi logout` 仅支持 Kimi Code 平台；若不是默认 config location 则直接拒绝。
2. 清理凭据存储：
   * keychain：删除 `service=kimi-code` + `key=oauth/kimi-code`
   * 文件：删除 `~/.kimi/credentials/kimi-code.json`
3. 更新 `config.toml`（仅默认位置）：
   * 删除 `providers."managed:kimi-code"` 整体配置
   * 删除 `models` 中所有 `provider = "managed:kimi-code"` 的条目
   * 若 `default_model` 指向被删除的模型，则清空 `default_model`
   * `services.moonshot_search = None`
   * `services.moonshot_fetch = None`
4. Shell `/logout` 成功后触发 `Reload`；`kimi logout` 仅执行退出流程并退出。

### 5) Token 与凭据存储（最佳实践）

优先使用系统凭据存储，避免将 access_token / refresh_token 明文落盘：

* 首选：OS keychain（`keyring`）
  * service: `kimi-code`
  * key: `oauth/kimi-code`
  * value: JSON（access_token、refresh_token、expires_at、scope、token_type）
* 兜底：`~/.kimi/credentials/kimi-code.json`，权限 `0600`

`config.toml` 仅保存非敏感元信息与引用，不直接写入 token。`expires_at` 与 `scope` 也放在
凭据存储中以避免重复更新。provider 与 services 都使用同一套 oauth 引用，运行时通过
`runtime.oauth` 读取 access_token 并注入调用路径（内存态），不支持退化为写入
`config.toml`：

```toml
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""
oauth = { storage = "keyring", key = "oauth/kimi-code" } # keyring 不可用时为 file

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = ""
oauth = { storage = "keyring", key = "oauth/kimi-code" } # keyring 不可用时为 file

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = ""
oauth = { storage = "keyring", key = "oauth/kimi-code" } # keyring 不可用时为 file
```

`api_key` 为空字符串仅作为占位，运行时注入 access_token。
若 keychain 不可用，使用 `~/.kimi/credentials/kimi-code.json`；不允许写入 `config.toml`。

### 6) Token 刷新策略

* 每次用户 prompt 触发时，在后台读取凭据存储中的 `expires_at` 并尽量刷新：
  * 若已过期则强制刷新；若剩余时间 < 5 分钟则后台刷新
  * 挂载点：`KimiSoul.run(...)` 开始时触发 `ensure_fresh`
* 刷新流程（带上上面的设备信息 headers）：
  * `grant_type=refresh_token`
  * `refresh_token`, `client_id`
* 刷新成功：
  * 更新凭据存储中的 access_token / refresh_token / expires_at
  * 更新内存中的 `api_key`（仅对 `Kimi` provider 生效）
* 刷新失败：
  * 仅记录日志警告，不触发 UI 提示或 `Reload`

### 7) LLM 与工具的热更新策略

* 目标：刷新 token 后不打断用户输入与对话。
* LLM 热更新：
  * 当前实现直接更新 `Kimi` chat provider 的 `client.api_key`，不触发重建或 Reload。
* 搜索/抓取：
  * `SearchWeb` / `FetchURL` 每次调用从 `runtime.oauth.resolve_api_key(...)` 获取 token，
    不缓存 api_key，刷新后立即生效。

### 8) 与 /setup 的关系

* `/setup` 仍保留 API key 交互，OAuth 仅通过 `/login`。
* `/login` 使用与 `/setup` 相同的托管命名空间：
  * provider key: `managed:kimi-code`
  * model key: `kimi-code/<model-id>`
* 可选：未来在 `/setup` 中提供 “Login with browser (OAuth)” 入口，但非本次目标。

## 边界与兼容性

* 如果用户使用 `--config` / `--config-file`，直接拒绝 `/login`（避免凭据落在非默认路径）。
* 只要平台提供 `search_url` / `fetch_url` 就会写入 `services` 配置。
* OAuth 模型和 API 兼容性与当前 Bearer key 完全一致。

## 待确认事项

* Device Authorization 是否强制要求 `scope`，以及 scope 的最终命名（当前实现未发送）。

## 关键参考位置

* `/setup` 入口：`src/kimi_cli/ui/shell/setup.py`
* 平台定义：`src/kimi_cli/auth/platforms.py`
* 配置结构：`src/kimi_cli/config.py`
* Kimi provider：`packages/kosong/src/kosong/chat_provider/kimi.py`

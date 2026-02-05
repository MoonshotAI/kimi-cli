---
Author: "@stdrc"
Updated: 2026-01-26
Status: Draft
---

# KLIP-15: kagent Rust kernel 以 sidecar 方式接入 kimi-cli

## 背景与现状

* Python 版 kimi-cli 的 Agent kernel 由 `KimiSoul` 驱动（`src/kimi_cli/soul/kimisoul.py`）。
* UI（shell/print）与 ACP server 通过 Wire 事件与 kernel 交互。
* Wire 协议已稳定，详见 `docs/zh/customization/wire-mode.md`（JSON-RPC 2.0 + stdio）。
* Rust 版 kagent 已实现相同协议与核心逻辑，目标是替换 Python kernel，但**保留 Python UI/ACP**。

## 目标

* 在 **不删除** Python kernel 的前提下，引入 Rust kagent 作为默认或可选 kernel。
* Python 侧仍负责：UI（shell/print）、ACP server、配置/会话/技能发现。
* kernel 实现通过 **stdio wire 协议** 与 Python 通讯，保持与现有外部 Wire 客户端一致。
* 支持 **fallback**：Rust kernel 启动失败或运行异常时回退到 Python kernel。
* 打包/发布流程支持多平台（Linux/macOS/Windows，含 Linux ARM），并能在 wheel 中携带 kagent 二进制。

## 非目标

* 不把 Rust kernel 直接嵌入 Python 进程（不做 Pyo3 绑定）。
* 不移除 Python kernel 代码；仅在运行时切换。
* 不修改 wire 协议。

## 方案概览（sidecar + stdio wire）

将 Rust kagent 视为 **实现 wire 协议的外部 server**，Python 通过一个 `WireBackedSoul`（代理 Soul）启动子进程并转发消息：

```
Python UI/ACP  <->  Python Wire  <->  WireBackedSoul  <->  stdio  <->  kagent
```

* Python UI/ACP 仍只感知本地 `Wire`，无需改动。
* `WireBackedSoul` 实现 Soul 接口（`run()`/`status`/`available_slash_commands`），用 Rust 进程替代 `KimiSoul` 执行。
* 所有 Approval/ToolCall/StatusUpdate 事件由 Rust 发送，Python 仅做**消息转发与本地 UI 适配**。

## 详细设计

### 1) 新增 WireBackedSoul

**职责**
* 启动/管理 Rust kagent 进程（`kagent --wire`）。
* 通过 stdio 与 Rust kernel 进行 JSON-RPC 交互。
* 将 Rust 发来的 `event` 透传为 `wire_send(...)`（送到 Python UI/ACP）。
* 将 Rust 发来的 `request`（Approval/ToolCall）映射为本地 Wire 请求，收集 UI 响应，再回写给 Rust。

**最小行为**
* `initialize`：可选握手，获取 slash commands / server info。
* `prompt`：触发一轮执行，Rust 侧持续发送事件与请求，直到返回 `PromptResult`。
* `cancel`：转发取消请求给 Rust。

**对象模型**
* `WireBackedSoul` 持有：
  - `process`（subprocess handle）
  - `client`（wire client，负责 JSON-RPC 的 request/response）
  - `status`（来自 StatusUpdate 事件）
  - `slash_commands`（来自 initialize result）

### 2) Approval/ToolCall 转发

Rust -> Python：
* Rust 通过 wire `request` 发送 `ApprovalRequest` / `ToolCallRequest`。
* Python 侧创建本地 `ApprovalRequest`/`ToolCallRequest` 对象，`wire_send` 到 UI。
* UI resolve 后，Python 将结果作为 JSON-RPC response 回写给 Rust。

关键点：不复制/重建 Rust-side pending future，而是**用本地 wire 作为交互表面**，保证 UI 行为与现有一致。

### 3) 进程生命周期与容错

* 启动：`kagent --wire`（必要时附加 `--config` 或环境变量）
* 退出：
  - 正常：Rust 自行退出；Python 处理 EOF 并结束 run
  - 异常：Python 检测 stderr/exit code，回退到 Python kernel 或报错
* 取消：调用 wire `cancel` 请求
* 失败回退：可配置 `kernel = rust` 或 `kernel = python`；当 rust 失败时自动 fallback

### 4) 运行时选择与配置

建议增加运行时切换方式（优先级从高到低）：
1. CLI flag：`--kernel rust|python`（默认可为 `rust`）
2. 环境变量：`KIMI_KERNEL=rust|python`
3. 配置文件：`[runtime] kernel = "rust"`

在 `KimiCLI.create` 中选择 `KimiSoul` 或 `WireBackedSoul`。

### 5) 打包与分发（maturin）

**策略**：maturin 构建 Python package + 打包 sidecar 二进制。

* 产物：
  - Python wheel（包含 `kagent` 可执行文件）
  - Python 代码负责定位并调用该二进制
* 运行时查找优先级：
  1) `KIMI_KERNEL_BIN` 环境变量
  2) package 内嵌二进制路径
  3) 系统 PATH

**平台矩阵**
* Linux x86_64 / ARM64
* macOS ARM64
* Windows x86_64

### 6) 兼容与迁移策略

* Python kernel 保留并可显式启用。
* Rust kernel 失败可自动 fallback。
* 既有 wire/client 协议不变。
* e2e 测试通过 `KIMI_E2E_WIRE_CMD` 指定 Rust kernel。

## 测试与验证

* Rust：`cargo fmt` / `cargo check` / `cargo test`
* Python：现有 UI/ACP 测试继续
* e2e：`KIMI_E2E_WIRE_CMD=... uv run pytest tests_e2e`
* CI：增加多平台 Rust + e2e 覆盖

## 替代方案（不选）

**Pyo3 绑定（in-process Rust kernel）**
* 优点：更低延迟、无进程管理。
* 缺点：绑定维护成本高、生命周期/async 与 GIL 复杂、隔离性差。

结论：sidecar 模式更符合现有 wire 设计与业界实践（binary + Python wrapper）。

## 开放问题

* Rust kernel 是否需要从 Python 侧注入更多 runtime 信息（如 workdir listing / skills）？
* 是否需要在 wire `initialize` 中扩展 metadata（如 kernel capabilities / feature flags）？
* 失败回退是否应默认启用，还是仅在 `kernel=auto` 时启用？

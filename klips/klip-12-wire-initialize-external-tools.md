---
Author: "@stdrc"
Updated: 2026-01-14
Status: Draft
---

# KLIP-12: Wire 初始化协商与外部工具调用

## Summary

为 Wire 模式引入 client-to-server 的 `initialize` 握手，支持 client 提交 `external_tools`
定义、server 回传 soul-level `slash_commands` 列表，并扩展 `request` 方法以承载
`ToolCallRequest`（外部工具调用请求）。新增 `ApprovalResponse` 类型，与 `ToolResult`
对称，统一 `request` 的响应语义。

## 背景与动机

当前 Wire 协议（`docs/zh/customization/wire-mode.md` + `src/kimi_cli/wire/*`,
`src/kimi_cli/ui/wire/*`）只包含：

- `prompt`/`cancel`（client -> server）
- `event`/`request`（server -> client；`request` 仅用于审批）

缺口：

- 缺少初始化协商：client 无法在会话开始时提交能力与扩展信息。
- 外部工具无法接入：client 自带的工具（例如 IDE 内部工具）不能注册给模型使用。
- Slash commands 无法被外部 UI 感知：client 只能硬编码或忽略，无法展示/补全。
- `request` 返回结构不统一：审批返回是一个特化结构，无法复用给 tool 请求。

因此需要一个结构化的初始化协商和对称的 request/response 模型。

## 目标

- 新增 `initialize` 请求，支持 client 提供 `external_tools`，server 返回 soul-level
  `slash_commands`。
- 将 server -> client 的 tool 调用请求标准化为 `request` 方法，params 为 `ToolCallRequest`。
- 引入 `ApprovalResponse` 类型（必要时重命名现有 Response literal），让
  `request` 的返回类型统一为 `ApprovalResponse | ToolResult`。
- 保持向后兼容：旧 client 仍可直接 `prompt`。

## 非目标

- 不改变 `ToolCall`/`ToolResult` 的核心结构。
- 不引入新的传输通道（仍为 JSON-RPC over stdio）。
- 不讨论外部工具的权限或安全策略（由 client 自行处理）。

## 设计概览

### 1) `initialize` 握手

新增 client -> server 的 JSON-RPC 请求 `initialize`。它是可选但推荐的握手：

- client 提交 `external_tools`、`protocol_version`。
- server 返回协商后的 `protocol_version`、`slash_commands`（仅 soul-level）等。

若 client 不发送 `initialize`，服务端行为保持现状：不注册 external tools，也不推送
slash command 列表。

### 2) ExternalToolCall 请求

扩展 `request` 方法语义：

- 现状：`request` 仅携带 `ApprovalRequest`，响应为审批结果。
- 目标：`request` 可携带 `ApprovalRequest | ToolCallRequest`。
  - `ApprovalRequest` 表示审批。
  - `ToolCallRequest` 表示 ExternalToolCall（server 请求 client 执行外部工具）。

响应类型统一为：`ApprovalResponse | ToolResult`。

### 3) ApprovalResponse 类型

将审批响应抽象为 `ApprovalResponse`，与 `ToolResult` 对称：

- `ApprovalResponse` 对应 `ApprovalRequest`。
- `ToolResult` 对应 `ToolCall`/`ToolCallRequest`。

如果需要消除命名冲突，现有 `Response` literal 可改名为 `ApprovalResponseKind`。

## 协议变更细节

### `initialize` 请求

#### Request

```json
{
  "jsonrpc": "2.0",
  "method": "initialize",
  "id": "init-1",
  "params": {
    "protocol_version": "1.1",
      "client": {"name": "my-ui", "version": "0.3.0"},
      "external_tools": [
        {
          "name": "open_in_ide",
          "description": "Open file in IDE",
          "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"]
          }
        }
      ]
  }
}
```

#### Types (TS 风格)

```ts
interface InitializeParams {
  protocol_version: string
  client?: { name: string; version?: string }
  external_tools?: ExternalTool[]
}

interface ExternalTool {
  name: string
  description: string
  parameters: object // JSON Schema
}
```

### `initialize` 响应

```json
{
  "jsonrpc": "2.0",
  "id": "init-1",
  "result": {
    "protocol_version": "1.1",
    "server": {"name": "kimi-cli", "version": "0.68.0"},
    "slash_commands": [
      {"name": "init", "description": "Analyze the codebase ...", "aliases": []},
      {"name": "compact", "description": "Compact the context", "aliases": []}
    ],
    "external_tools": {
      "accepted": ["open_in_ide"],
      "rejected": [{"name": "shell", "reason": "conflicts with builtin tool"}]
    }
  }
}
```

#### Types

```ts
interface InitializeResult {
  protocol_version: string
  server: { name: string; version: string }
  slash_commands: SlashCommand[]
  external_tools?: {
    accepted: string[]
    rejected: { name: string; reason: string }[]
  }
}

interface SlashCommand {
  name: string
  description: string
  aliases: string[]
}
```

备注：

- `slash_commands` 仅包含 soul-level 命令：
  `src/kimi_cli/soul/slash.py` registry + 动态 skills（`KimiSoul._register_skill_commands`）。
- `external_tools` 的接受/拒绝结果可选，用于反馈命名冲突或 schema 校验失败。

## ExternalToolCall 与 ApprovalResponse

### Wire 请求类型扩展

```ts
type Request = ApprovalRequest | ToolCallRequest
// ToolCallRequest 在 request 语境下即 ExternalToolCall

interface ToolCallRequest {
  id: string
  name: string
  arguments?: string | null // JSON string
}
```

### 请求响应类型

```ts
type RequestResult = ApprovalResponse | ToolResult

interface ApprovalResponse {
  request_id: string
  response: ApprovalResponseKind
}

type ApprovalResponseKind = "approve" | "approve_for_session" | "reject"
```

### ExternalToolCall 示例

Server -> Client:

```json
{"jsonrpc":"2.0","method":"request","id":"tc-1","params":{
  "type":"ToolCallRequest",
  "payload":{"id":"tc-1","name":"open_in_ide","arguments":"{\"path\":\"README.md\"}"}
}}
```

Client -> Server:

```json
{"jsonrpc":"2.0","id":"tc-1","result":{
  "tool_call_id":"tc-1",
  "return_value":{
    "is_error":false,
    "output":"Opened",
    "message":"Opened README.md",
    "display":[]
  }
}}
```

### ApprovalRequest 示例（保持兼容）

Server -> Client:

```json
{"jsonrpc":"2.0","method":"request","id":"req-1","params":{
  "type":"ApprovalRequest",
  "payload":{"id":"req-1","tool_call_id":"tc-9","sender":"Shell","action":"run shell",
    "description":"Run command `ls`","display":[]}
}}
```

Client -> Server:

```json
{"jsonrpc":"2.0","id":"req-1","result":{
  "request_id":"req-1",
  "response":"approve"
}}
```

## Server 侧行为

### 初始化协商

- `WireOverStdio` 新增 `_handle_initialize`：
  - 解析 `external_tools`。
  - 将外部工具注册到 `KimiToolset`（新增 `WireExternalTool`）。
  - 若同名外部工具已存在，则按最新 schema/描述覆盖更新。
  - 采集 `KimiSoul.available_slash_commands` 生成 `slash_commands`。
  - 返回协商结果。

### 外部工具执行

- `WireExternalTool` 以工具代理的形式加入 toolset。
- 当模型触发该工具：
  - server 通过 Wire `request` 发送 `ToolCallRequest` 给 client。
  - 等待 client 返回 `ToolResult`。
  - 将 `ToolResult.return_value` 作为 tool 执行结果回传给模型。

### 事件流

- `ToolCall` 和 `ToolResult` 仍可作为 `event` 对 UI 可视化输出。
- External tool 的执行结果同时参与 `event` 流与 `request` 响应，可用于录像/回放。

## Client 侧变化

### 启动流程

1. 建立 stdio 连接。
2. 发送 `initialize`：
   - 提交 `external_tools`。
   - 可携带 client 名称与版本。
3. 接收 `slash_commands`：
   - 用于 UI 展示与自动补全。
4. 进入交互阶段（`prompt`/`cancel`）。

### `request` 处理逻辑

收到 `request` 时根据 params 类型分派：

- `ApprovalRequest` -> 弹出审批 UI -> 返回 `ApprovalResponse`。
- `ToolCallRequest` -> 执行 external tool -> 返回 `ToolResult`。

对未知类型返回 JSON-RPC error 并记录日志。

## 兼容性与降级策略

- 旧 client：不发 `initialize`，协议维持 v1.0 行为。
- 新 client + 旧 server：`initialize` 可能返回 JSON-RPC method not found（-32601），
  client 应自动降级并继续使用 v1.0。
- 若 `external_tools` 校验失败或重名，server 在 `initialize` result 中标记为 rejected，
  并忽略该工具。
- 旧类型名 `ApprovalRequestResolved` 在反序列化时仍可被识别。

## 实施步骤（建议）

1. 协议与类型层
   - `src/kimi_cli/wire/types.py`：
     - `Request = ApprovalRequest | ToolCallRequest`。
     - 新增 `ApprovalResponse`（保留旧 `ApprovalRequestResolved` 类型名兼容）。
   - `src/kimi_cli/wire/serde.py` 无需改动（由 Envelope 支持新类型）。
2. JSON-RPC 层
   - `src/kimi_cli/ui/wire/jsonrpc.py`：
     - 添加 `JSONRPCInitializeMessage`。
     - `JSONRPCInMessage`/`OutMessage` 增加 `initialize`。
3. Wire 服务端
   - `src/kimi_cli/ui/wire/__init__.py`：
     - 实现 `_handle_initialize`。
     - 增强 `_pending_requests` 以支持 `ToolCallRequest`。
4. 工具层
   - `src/kimi_cli/soul/toolset.py`：
     - 新增 `WireExternalTool`，内部通过 Wire 请求执行。
5. 协议版本与文档
   - `src/kimi_cli/ui/wire/protocol.py` 提升协议版本。
   - 更新 `docs/zh/customization/wire-mode.md` 并新增 external tools 章节。

## 最终效果与用法

- external tools 成为 Wire session 可协商的能力，client 可以把自己的工具直接暴露给模型。
- 外部 UI 可以动态展示 soul-level slash commands，不再硬编码。
- `request` 方法在语义与类型上统一（审批与外部工具调用共用一套请求框架）。
- 旧 client 无需修改即可继续工作。

## 关键参考位置

- Wire 协议与类型：`src/kimi_cli/wire/types.py`, `src/kimi_cli/wire/serde.py`
- Wire JSON-RPC：`src/kimi_cli/ui/wire/jsonrpc.py`, `src/kimi_cli/ui/wire/__init__.py`
- Slash commands：`src/kimi_cli/soul/slash.py`, `src/kimi_cli/utils/slashcmd.py`
- Wire 文档：`docs/zh/customization/wire-mode.md`

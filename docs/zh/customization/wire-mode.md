# Wire 模式

Wire 模式是 Kimi CLI 的底层通信协议，用于与外部程序进行结构化的双向通信。

## Wire 是什么

Wire 是 Kimi CLI 内部使用的消息传递层。当你使用终端交互时，Shell UI 通过 Wire 接收 AI 的输出并显示；当你使用 ACP 集成到 IDE 时，ACP 服务器也通过 Wire 与 Agent 核心通信。

Wire 模式（`--wire`）将这个通信协议暴露出来，允许外部程序直接与 Kimi CLI 交互。这适用于构建自定义 UI 或将 Kimi CLI 嵌入到其他应用中。

```sh
kimi --wire
```

## Wire 协议

Wire 使用基于 JSON-RPC 2.0 的协议，通过 stdin/stdout 进行双向通信。

**消息格式**

每条消息是一行 JSON，符合 JSON-RPC 2.0 规范：

```json
{"jsonrpc": "2.0", "method": "...", "params": {...}}
```

**方法类型**

| method | 方向 | 说明 |
|--------|------|------|
| `event` | Agent → Client | Agent 发出的事件 |
| `request` | Agent → Client | 需要响应的请求（如审批） |
| `prompt` | Client → Agent | 发送用户输入 |
| `cancel` | Client → Agent | 取消当前操作 |

**事件消息示例**

```json
{"jsonrpc": "2.0", "method": "event", "params": {"type": "TextPart", "payload": {"text": "Hello"}}}
```

**请求消息示例**

需要审批的操作会发送请求，客户端需要响应：

```json
{"jsonrpc": "2.0", "method": "request", "id": "req-1", "params": {"type": "ApprovalRequest", "payload": {...}}}
```

## Wire 消息

Wire 消息分为事件（Event）和请求（Request）两类。

### 事件类型

**控制流事件**

| 类型 | 说明 |
|------|------|
| `TurnBegin` | 回合开始，包含用户输入 |
| `StepBegin` | 步骤开始，包含步骤编号 |
| `StepInterrupted` | 步骤被中断 |
| `CompactionBegin` | 上下文压缩开始 |
| `CompactionEnd` | 上下文压缩结束 |
| `StatusUpdate` | 状态更新（上下文使用率、token 用量等） |

**内容事件**

| 类型 | 说明 |
|------|------|
| `TextPart` | 文本内容片段 |
| `ThinkPart` | 思考内容片段 |
| `ToolCall` | 工具调用 |
| `ToolCallPart` | 工具调用片段（流式） |
| `ToolResult` | 工具执行结果 |
| `ImageURLPart` | 图片内容 |

**子 Agent 事件**

| 类型 | 说明 |
|------|------|
| `SubagentEvent` | 包装子 Agent 产生的事件 |

### 请求类型

| 类型 | 说明 |
|------|------|
| `ApprovalRequest` | 请求用户批准操作 |

**ApprovalRequest 响应**

收到 `ApprovalRequest` 后，客户端需要发送响应：

```json
{"jsonrpc": "2.0", "method": "event", "params": {"type": "ApprovalRequestResolved", "payload": {"request_id": "...", "response": "approve"}}}
```

`response` 可选值：
- `approve`：批准本次操作
- `approve_for_session`：批准本会话中的同类操作
- `reject`：拒绝操作

## 使用场景

Wire 模式主要用于：

- **自定义 UI**：构建 Web、桌面或移动端的 Kimi CLI 前端
- **应用集成**：将 Kimi CLI 嵌入到其他应用程序中
- **自动化测试**：对 Agent 行为进行程序化测试

::: tip 提示
如果你只需要简单的非交互输入输出，使用 [Print 模式](./print-mode.md) 更简单。Wire 模式适合需要完整控制和双向通信的场景。
:::

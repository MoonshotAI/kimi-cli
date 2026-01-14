---
Author: "@stdrc"
Updated: 2026-01-14
Status: Proposed
---

# KLIP-8: Kimi Agent SDK (Python)

## 背景

Kimi CLI 目前主要作为命令行工具使用，但其核心架构（KimiSoul、Wire 协议、Approval 系统等）具备作为 SDK 被集成到其他应用的能力。为了让开发者能够在 Python 应用中使用 Kimi Agent 的能力，我们需要设计一套简洁、易用、可扩展的 SDK 接口。

## 设计目标

1. **简洁易用**：提供高层 API，一行代码即可调用 Agent
2. **功能完整**：支持流式输出、Approval 处理、MCP 工具扩展等高级功能
3. **类型安全**：完善的类型注解，支持 IDE 自动补全和静态检查
4. **架构一致**：与现有 `kimi_cli` 内部架构保持一致，复用核心组件

## 核心概念

### Wire 消息流

SDK 基于 Wire 协议与 Agent 交互。Wire 消息分为两类：

- **Event**：单向事件，不需要响应（如 `TextPart`、`ToolCall`、`StatusUpdate`）
- **Request**：需要响应的请求（如 `ApprovalRequest`）

### 消息类型概览

```
WireMessage
├── Event
│   ├── TurnBegin          # Turn started
│   ├── StepBegin          # Step started
│   ├── StepInterrupted    # Step interrupted
│   ├── CompactionBegin    # Context compaction started
│   ├── CompactionEnd      # Context compaction ended
│   ├── StatusUpdate       # Status update (token usage, etc.)
│   ├── ContentPart        # Content output (text, images, etc.)
│   │   ├── TextPart
│   │   ├── ThinkPart
│   │   ├── ImageURLPart
│   │   ├── AudioURLPart
│   │   └── VideoURLPart
│   ├── ToolCall           # Tool invocation
│   ├── ToolCallPart       # Tool call fragment (streaming)
│   ├── ToolResult         # Tool execution result
│   ├── SubagentEvent      # Sub-agent event
│   └── ApprovalRequestResolved  # Approval resolved
└── Request
    └── ApprovalRequest    # Request user approval
```

## API 设计

SDK 提供两层 API：

| 层级 | API | 返回类型 | 类比 CLI 模式 | 适用场景 |
|------|-----|----------|---------------|----------|
| 高层 | `prompt()` | `Message` | `--print --output stream-json` | 只关心内容输出 |
| 低层 | `Session.prompt()` | `WireMessage` | `--wire` | 需要完整控制（Approval、工具调用等）|

### 1. 高层 API：`prompt()` 函数

最简单的使用方式，只返回 `Message` 对象，隐藏底层细节：

```python
from kimi_agent_sdk import prompt, Message

async def main():
    # Simplest usage: auto-approve all Approvals (yolo mode)
    async for message in prompt("Write a hello world program", yolo=True):
        print(message.extract_text(), end="", flush=True)
    print()

    # Get full Message object (including tool_calls, etc.)
    async for message in prompt("List files in current directory", yolo=True):
        print(f"[{message.role}] {message.extract_text()}")
        if message.tool_calls:
            for tc in message.tool_calls:
                print(f"  Tool call: {tc.function.name}")

    # With image input
    from kimi_agent_sdk import ImageURLPart

    async for message in prompt([
        "这张图片里有什么？",
        ImageURLPart(image_url=ImageURLPart.ImageURL(url="data:image/png;base64,iVBORw0KGgo...")),
    ], yolo=True):
        print(message.extract_text())
```

函数签名：

```python
async def prompt(
    user_input: str | list[ContentPart],
    *,
    # Basic configuration
    work_dir: Path | str | None = None,       # --work-dir, -w
    config: Config | Path | None = None,      # --config / --config-file
    model: str | None = None,                 # --model, -m
    thinking: bool = False,                   # --thinking

    # Run mode
    yolo: bool = False,                       # --yolo, --yes, -y
    approval_handler_fn: ApprovalHandlerFn | None = None,  # SDK-specific

    # Extensions
    agent_file: Path | None = None,           # --agent-file
    mcp_configs: list[MCPConfig] | None = None,  # --mcp-config / --mcp-config-file
    skills_dir: Path | None = None,           # --skills-dir

    # Loop control
    max_steps_per_turn: int | None = None,    # --max-steps-per-turn
    max_retries_per_step: int | None = None,  # --max-retries-per-step
    max_ralph_iterations: int | None = None,  # --max-ralph-iterations

    # Output control
    final_message_only: bool = False,         # --final-message-only
) -> AsyncGenerator[Message, None]:
    """
    Send a prompt to the Kimi Agent and get streaming responses.

    This is the highest-level API that aggregates low-level Wire messages into
    Message objects, similar to `kimi --print --output stream-json` behavior.

    Args:
        user_input: User input, can be text or a list containing various content types.
        work_dir: Working directory. Defaults to current directory.
        config: Configuration object or path to config file.
        model: Model name, e.g., "kimi", "claude-sonnet", etc.
        thinking: Whether to enable thinking mode (requires model support).
        yolo: Automatically approve all Approval requests.
        approval_handler_fn: Custom Approval handler callback (mutually exclusive with yolo).
        agent_file: Custom agent specification file.
        mcp_configs: List of MCP server configurations.
        skills_dir: Custom skills directory.
        max_steps_per_turn: Maximum number of steps in one turn.
        max_retries_per_step: Maximum number of retries in one step.
        max_ralph_iterations: Extra iterations in Ralph mode (-1 for unlimited).
        final_message_only: Only return the Message from the last step.

    Yields:
        Message: Aggregated message object containing role, content, tool_calls, etc.

    Raises:
        LLMNotSet: When the LLM is not set.
        LLMNotSupported: When the LLM does not have required capabilities.
        ChatProviderError: When the LLM provider returns an error.
        MaxStepsReached: When the maximum number of steps is reached.
        RunCancelled: When the run is cancelled by the cancel event.
        ValueError: When neither yolo=True nor approval_handler_fn is provided.
    """
    ...
```

### 2. Approval 处理

Approval 是 Agent 执行敏感操作（如执行 shell 命令、写入文件）前请求用户确认的机制。

**在高层 API (`prompt()`) 中**，Approval 是透明的——你必须通过 `yolo` 或 `approval_handler_fn` 处理，不会在消息流中出现：

#### 方式一：YOLO 模式（自动批准）

```python
# Auto-approve all requests, suitable for trusted environments or scripting
async for msg in prompt("Delete /tmp/cache directory", yolo=True):
    print(msg.extract_text())
```

#### 方式二：自定义 approval_handler_fn

```python
from kimi_agent_sdk import prompt, ApprovalRequest, ApprovalResponseKind

async def my_approval_handler(request: ApprovalRequest) -> ApprovalResponseKind:
    # request.sender: Tool name that initiated the request (e.g., "bash")
    # request.action: Action type (e.g., "run shell command")
    # request.description: Detailed description
    # request.display: Visualization info (e.g., diff content)

    print(f"[{request.sender}] {request.description}")
    response = input("Approve? [y/n/s(ession)]: ").strip().lower()

    if response == "y":
        return "approve"
    elif response == "s":
        return "approve_for_session"  # Auto-approve similar operations for this session
    else:
        return "reject"

async for msg in prompt("执行 ls -la", approval_handler_fn=my_approval_handler):
    print(msg.extract_text())
```

**在低层 API (`Session.prompt()`) 中**，你可以直接在消息流中处理 `ApprovalRequest`：

```python
async with await Session.create(work_dir=".") as session:
    async for wire_msg in session.prompt("Run ls -la"):
        match wire_msg:
            case ApprovalRequest() as req:
                print(f"Approval requested: {req.description}")
                req.resolve("approve")  # or "reject" / "approve_for_session"
            case TextPart(text=text):
                print(text, end="")
```

> **注意**：使用低层 API 时，如果不处理 `ApprovalRequest`，Session 会永久阻塞。

### 3. 低层 API：`Session` 类

当需要更多控制时（如会话管理、取消操作、手动处理 Approval），使用 `Session` 类：

```python
from kimi_agent_sdk import Session, TextPart, ApprovalRequest
import asyncio

async def main():
    # Create Session instance
    session = await Session.create(
        work_dir="/path/to/project",
        model="kimi",
    )

    # Get Session status
    print(f"Session ID: {session.id}")
    print(f"Model: {session.model_name}")
    print(f"Context usage: {session.status.context_usage:.1%}")

    # Use prompt() to get WireMessage (can manually handle Approval)
    async for wire_msg in session.prompt("Help me refactor this project"):
        match wire_msg:
            case TextPart(text=text):
                print(text, end="", flush=True)
            case ApprovalRequest() as req:
                # Can call session.cancel() from another task to cancel
                req.resolve("approve")

    # Continue conversation (preserving context)
    async for wire_msg in session.prompt("Add unit tests"):
        match wire_msg:
            case TextPart(text=text):
                print(text, end="", flush=True)
            case ApprovalRequest() as req:
                req.resolve("approve")

    # Clean up resources
    await session.close()

# Recommended: use async with
async def main_with_context():
    async with await Session.create(work_dir=".") as session:
        async for wire_msg in session.prompt("hello"):
            match wire_msg:
                case TextPart(text=text):
                    print(text, end="")
                case ApprovalRequest() as req:
                    req.resolve("approve")
```

`Session` 类签名：

```python
class Session:
    """Kimi Agent session with full low-level control capabilities."""

    @staticmethod
    async def create(
        work_dir: Path | str | None = None,
        *,
        # Basic configuration
        session_id: str | None = None,        # --session, -S
        config: Config | Path | None = None,  # --config / --config-file
        model: str | None = None,             # --model, -m
        thinking: bool = False,               # --thinking

        # Run mode
        yolo: bool = False,                   # --yolo, --yes, -y

        # Extensions
        agent_file: Path | None = None,       # --agent-file
        mcp_configs: list[MCPConfig] | None = None,  # --mcp-config / --mcp-config-file
        skills_dir: Path | None = None,       # --skills-dir

        # Loop control
        max_steps_per_turn: int | None = None,    # --max-steps-per-turn
        max_retries_per_step: int | None = None,  # --max-retries-per-step
        max_ralph_iterations: int | None = None,  # --max-ralph-iterations
    ) -> Session:
        """Create a new Session instance."""
        ...

    @staticmethod
    async def resume(
        work_dir: Path | str,
        session_id: str | None = None,  # None means resume the most recent session (corresponds to CLI --continue)
        **kwargs,  # Other parameters same as create()
    ) -> Session | None:
        """Resume an existing session. Returns None if session does not exist."""
        ...

    @property
    def id(self) -> str:
        """Session ID."""
        ...

    @property
    def model_name(self) -> str:
        """Name of the current model."""
        ...

    @property
    def status(self) -> StatusSnapshot:
        """Current status snapshot (context usage, yolo state, etc.)."""
        ...

    async def prompt(
        self,
        user_input: str | list[ContentPart],
        *,
        merge_wire_messages: bool = False,  # Merge consecutive messages of the same type (e.g., TextPart)
    ) -> AsyncGenerator[WireMessage, None]:
        """
        Send a prompt and get a WireMessage stream.

        Args:
            user_input: User input, can be text or a list containing various content types.
            merge_wire_messages: Whether to merge consecutive messages of the same type.
                Defaults to False.

        Returns:
            AsyncGenerator[WireMessage, None]: Wire message stream, including ApprovalRequest.

        Raises:
            LLMNotSet: When the LLM is not set.
            LLMNotSupported: When the LLM does not have required capabilities.
            ChatProviderError: When the LLM provider returns an error.
            MaxStepsReached: When the maximum number of steps is reached.
            RunCancelled: When the run is cancelled by the cancel event.

        Note:
            Callers must handle ApprovalRequest manually (unless yolo=True was set in create()).
            If ApprovalRequest is not handled, Session will block indefinitely.
            Use cancel() method to cancel the ongoing operation.
        """
        ...

    def cancel(self) -> None:
        """Cancel the current prompt operation. Raises RunCancelled."""
        ...

    async def close(self) -> None:
        """Close the Session and release resources."""
        ...

    async def __aenter__(self) -> Session:
        return self

    async def __aexit__(self, *args) -> None:
        await self.close()
```

### 4. 会话管理

SDK 支持会话持久化，允许跨进程恢复对话：

```python
from kimi_agent_sdk import Session

# Resume a specific session
session = await Session.resume("/path/to/project", session_id="abc-123")
if session:
    async for wire_msg in session.prompt("Continue previous work"):
        ...

# Resume the most recent session
session = await Session.resume("/path/to/project")  # session_id=None means most recent
```

### 5. 常用模式

```python
# Example: Get full text output
async def get_response(user_input: str) -> str:
    parts = []
    async for msg in prompt(user_input, yolo=True):
        parts.append(msg.extract_text())
    return "".join(parts)

# Example: Get only the final result (corresponds to CLI --final-message-only)
async def get_final_response(user_input: str) -> str:
    async for msg in prompt(user_input, yolo=True, final_message_only=True):
        return msg.extract_text()
    return ""

# Example: Collect all Thinking content
async def get_thinking(user_input: str) -> str:
    parts = []
    async for msg in prompt(user_input, yolo=True, thinking=True):
        for part in msg.content:
            if isinstance(part, ThinkPart):
                parts.append(part.think)
    return "\n".join(parts)

# Low-level API type guards
from kimi_agent_sdk import is_event, is_request, WireMessage

def handle_wire_message(msg: WireMessage):
    if is_request(msg):
        # Messages that require a response (e.g., ApprovalRequest)
        ...
    elif is_event(msg):
        # One-way events
        ...
```

## 完整示例

### 示例 1：简单问答

```python
import asyncio
from kimi_agent_sdk import prompt

async def main():
    async for msg in prompt("什么是 Python GIL？", yolo=True):
        print(msg.extract_text(), end="", flush=True)
    print()

asyncio.run(main())
```

### 示例 2：只获取最终结果

```python
import asyncio
from kimi_agent_sdk import prompt

async def main():
    # final_message_only=True returns only the final Message (corresponds to CLI --final-message-only)
    async for msg in prompt("What is 1+1?", yolo=True, final_message_only=True):
        print(f"Answer: {msg.extract_text()}")

asyncio.run(main())
```

### 示例 3：查看工具调用

```python
import asyncio
from kimi_agent_sdk import prompt

async def main():
    async for msg in prompt("List files in current directory", yolo=True):
        print(f"[{msg.role}]", end=" ")
        if msg.tool_calls:
            for tc in msg.tool_calls:
                print(f"Tool call: {tc.function.name}({tc.function.arguments})")
        elif msg.tool_call_id:
            print(f"Tool result: {msg.extract_text()[:50]}...")
        else:
            print(msg.extract_text())

asyncio.run(main())
```

### 示例 4：低层 API - 手动处理 Approval

```python
import asyncio
from kimi_agent_sdk import Session, TextPart, ToolCall, ToolResult, ApprovalRequest

async def main():
    async with await Session.create(work_dir=".") as session:
        async for wire_msg in session.prompt("Create a hello.py and run it"):
            match wire_msg:
                case TextPart(text=text):
                    print(text, end="", flush=True)
                case ToolCall(function=func):
                    print(f"\n🔧 Tool call: {func.name}")
                case ToolResult(return_value=ret):
                    if ret.is_error:
                        print(f"❌ Error: {ret.message}")
                    else:
                        print(f"✅ {ret.message}")
                case ApprovalRequest() as req:
                    print(f"\n⚠️  Approval requested: {req.description}")
                    # In real applications, show UI for user decision here
                    req.resolve("approve")
        print()

asyncio.run(main())
```

### 示例 5：使用 MCP 工具

```python
import asyncio
from kimi_agent_sdk import prompt

async def main():
    mcp_configs = [
        {
            "mcpServers": {
                "playwright": {
                    "command": "npx",
                    "args": ["-y", "@playwright/mcp@latest"],
                }
            }
        }
    ]

    async for msg in prompt(
        "打开 https://example.com 并截图",
        mcp_configs=mcp_configs,
        yolo=True,
    ):
        print(msg.extract_text(), end="", flush=True)
    print()

asyncio.run(main())
```

### 示例 6：可取消的长任务

```python
import asyncio
import signal
from kimi_agent_sdk import Session, TextPart, ApprovalRequest, RunCancelled

async def main():
    async with await Session.create(work_dir=".") as session:
        # Register SIGINT handler
        loop = asyncio.get_event_loop()
        loop.add_signal_handler(signal.SIGINT, session.cancel)

        try:
            async for wire_msg in session.prompt("Analyze this codebase and generate docs"):
                match wire_msg:
                    case TextPart(text=text):
                        print(text, end="", flush=True)
                    case ApprovalRequest() as req:
                        req.resolve("approve")
        except RunCancelled:
            print("\n\n⚠️  操作已取消")
        finally:
            loop.remove_signal_handler(signal.SIGINT)

asyncio.run(main())
```

### 示例 7：自定义 Approval 处理器（高层 API）

```python
import asyncio
from kimi_agent_sdk import prompt, ApprovalRequest, ApprovalResponseKind

async def main():
    async def gui_approval_handler(req: ApprovalRequest) -> ApprovalResponseKind:
        # Can integrate with Qt, Tkinter, or other GUI frameworks here
        print(f"[GUI Dialog] {req.sender}: {req.description}")
        await asyncio.sleep(0.1)  # Simulate user thinking
        return "approve"

    async for msg in prompt("执行 ls", approval_handler_fn=gui_approval_handler):
        print(msg.extract_text())

asyncio.run(main())
```

### 示例 8：多轮对话（低层 API）

```python
import asyncio
from kimi_agent_sdk import Session, TextPart, ApprovalRequest

async def main():
    async with await Session.create(work_dir=".") as session:
        # First turn
        async for wire_msg in session.prompt("Create a Python project structure"):
            match wire_msg:
                case TextPart(text=text):
                    print(text, end="", flush=True)
                case ApprovalRequest() as req:
                    req.resolve("approve")
        print("\n---")

        # Second turn (preserving context)
        async for wire_msg in session.prompt("Add a README.md"):
            match wire_msg:
                case TextPart(text=text):
                    print(text, end="", flush=True)
                case ApprovalRequest() as req:
                    req.resolve("approve")
        print("\n---")

        # Third turn
        async for wire_msg in session.prompt("Summarize what you did"):
            match wire_msg:
                case TextPart(text=text):
                    print(text, end="", flush=True)
                case ApprovalRequest() as req:
                    req.resolve("approve")

asyncio.run(main())
```

## 模块结构

```
kimi_agent_sdk/
├── __init__.py          # Public API exports
├── _prompt.py           # prompt() function implementation (high-level API)
├── _session.py          # Session class implementation (low-level API)
├── _approval.py         # ApprovalHandlerFn type alias
└── _aggregator.py       # WireMessage → Message aggregator
```

公开导出：

```python
# kimi_agent_sdk/__init__.py

from kimi_agent_sdk._prompt import prompt
from kimi_agent_sdk._session import Session
from kimi_agent_sdk._approval import ApprovalHandlerFn

# ============================================================
# High-level types (returned by prompt())
# ============================================================
from kosong.message import Message, ContentPart, TextPart, ThinkPart
from kosong.message import ImageURLPart, AudioURLPart, VideoURLPart
from kosong.message import ToolCall

# ============================================================
# Low-level types (returned by Session.prompt()) - Wire messages
# ============================================================
from kimi_cli.wire.types import (
    # Message base types
    WireMessage,
    Event,
    Request,

    # Control flow events
    TurnBegin,
    StepBegin,
    StepInterrupted,
    CompactionBegin,
    CompactionEnd,
    StatusUpdate,

    # Tool-related (low-level)
    ToolCallPart,
    ToolResult,
    ToolReturnValue,

    # Approval (needed for low-level API)
    ApprovalRequest,
    ApprovalRequestResolved,
    ApprovalResponseKind,

    # Sub-agent
    SubagentEvent,

    # Display types
    DisplayBlock,
    BriefDisplayBlock,
    DiffDisplayBlock,
    TodoDisplayBlock,

    # Others
    TokenUsage,
    is_event,
    is_request,
)

# ============================================================
# Exception types
# ============================================================
from kimi_cli.soul import (
    LLMNotSet,
    LLMNotSupported,
    MaxStepsReached,
    RunCancelled,
    StatusSnapshot,
)

# Configuration types
from kimi_cli.config import Config

__all__ = [
    # ========== Core API ==========
    "prompt",           # High-level function, returns Message
    "Session",          # Low-level class, returns WireMessage

    # ========== Approval ==========
    "ApprovalHandlerFn",
    "ApprovalResponseKind",
    "ApprovalRequest",  # Needed for low-level API

    # ========== High-level types ==========
    "Message",          # Aggregated message
    "ContentPart",      # Content part base
    "TextPart",         # Text content
    "ThinkPart",        # Thinking content
    "ImageURLPart",     # Image
    "AudioURLPart",     # Audio
    "VideoURLPart",     # Video
    "ToolCall",         # Tool call

    # ========== Low-level types (Wire) ==========
    "WireMessage",
    "Event",
    "Request",
    "TurnBegin",
    "StepBegin",
    "StepInterrupted",
    "CompactionBegin",
    "CompactionEnd",
    "StatusUpdate",
    "ToolCallPart",
    "ToolResult",
    "ToolReturnValue",
    "ApprovalRequestResolved",
    "SubagentEvent",
    "DisplayBlock",
    "BriefDisplayBlock",
    "DiffDisplayBlock",
    "TodoDisplayBlock",
    "TokenUsage",
    "is_event",
    "is_request",

    # ========== Exceptions ==========
    "LLMNotSet",
    "LLMNotSupported",
    "MaxStepsReached",
    "RunCancelled",

    # ========== Others ==========
    "StatusSnapshot",
    "Config",
]
```

## 实现细节

### 与 `kimi_cli` 的关系

SDK 是 `kimi_cli` 的薄封装层，提供两层抽象：

```
┌─────────────────────────────────────────────────────────────────┐
│  kimi_agent_sdk                                                 │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  高层 API                                                 │  │
│  │                                                           │  │
│  │  prompt() ─────────────┐                                  │  │
│  │                        │    ┌─────────────┐               │  │
│  │                        ├───>│ Aggregator  │──> Message 流 │  │
│  │                        │    │ (Wire→Msg)  │               │  │
│  │                        │    └─────────────┘               │  │
│  └────────────────────────┼─────────────────────────────────┘  │
│                           │                                     │
│  ┌────────────────────────┼─────────────────────────────────┐  │
│  │  低层 API              │                                  │  │
│  │                        v                                  │  │
│  │  Session.prompt() ─────────────────────> WireMessage 流   │  │
│  │       │                                                   │  │
│  └───────┼───────────────────────────────────────────────────┘  │
│          │                                                      │
└──────────┼──────────────────────────────────────────────────────┘
           │
           v
┌──────────────────────────────────────────────────────────────────┐
│  kimi_cli                                                        │
│                                                                  │
│  KimiCLI.run() ───> run_soul() ───> KimiSoul ───> Wire          │
│       │                                                          │
│       └───> Session (work_dir, context persistence)              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**API 对应关系：**

| SDK API | CLI 模式 | 返回类型 |
|---------|----------|----------|
| `prompt()` | `kimi --print --output stream-json` | `Message` |
| `prompt(final_message_only=True)` | `kimi --print --output stream-json --final-message-only` | `Message` |
| `Session.prompt()` | `kimi --wire` | `WireMessage` |

**参数对应关系（按 SDK 分组顺序）：**

| CLI 参数 | SDK 参数 | 说明 |
|----------|----------|------|
| **基础配置** | | |
| `--work-dir`, `-w` | `work_dir` | 工作目录 |
| `--session`, `-S` | `session_id` | 指定会话 ID（仅 Session） |
| `--continue`, `-C` | `Session.resume()` | 恢复最近会话 |
| `--config` / `--config-file` | `config` | 配置对象或文件路径 |
| `--model`, `-m` | `model` | 模型名称 |
| `--thinking` | `thinking` | 启用 thinking 模式 |
| **运行模式** | | |
| `--yolo`, `--yes`, `-y` | `yolo` | 自动批准 |
| - | `approval_handler_fn` | 自定义审批处理回调（仅 prompt） |
| **扩展** | | |
| `--agent-file` | `agent_file` | 自定义 agent 配置文件 |
| `--mcp-config` / `--mcp-config-file` | `mcp_configs` | MCP 配置列表 |
| `--skills-dir` | `skills_dir` | 自定义 skills 目录 |
| **循环控制** | | |
| `--max-steps-per-turn` | `max_steps_per_turn` | 单次 turn 最大步数 |
| `--max-retries-per-step` | `max_retries_per_step` | 单步最大重试次数 |
| `--max-ralph-iterations` | `max_ralph_iterations` | Ralph 模式额外迭代次数 |
| **输出控制** | | |
| `--final-message-only` | `final_message_only` | 只返回最终消息（仅 prompt） |
```

### ApprovalHandlerFn 类型

```python
# kimi_agent_sdk/_approval.py
from collections.abc import Awaitable, Callable

from kimi_cli.wire.types import ApprovalRequest, ApprovalResponseKind

type ApprovalHandlerFn = (
    Callable[[ApprovalRequest], ApprovalResponseKind]
    | Callable[[ApprovalRequest], Awaitable[ApprovalResponseKind]]
)
"""
Approval handler callback function type.

The callback receives an ApprovalRequest with the following attributes:
    - id: Unique request identifier
    - tool_call_id: Associated tool call ID
    - sender: Name of the tool that initiated the request
    - action: Action type
    - description: Detailed description
    - display: List of visualization info

Returns:
    - "approve": Approve this request
    - "approve_for_session": Approve and auto-approve subsequent similar requests
    - "reject": Reject the request
"""
```

### prompt() 函数实现概要

```python
# kimi_agent_sdk/_prompt.py
import asyncio
import inspect

async def prompt(
    user_input: str | list[ContentPart],
    *,
    # Basic configuration
    work_dir: Path | str | None = None,
    config: Config | Path | None = None,
    model: str | None = None,
    thinking: bool = False,
    # Run mode
    yolo: bool = False,
    approval_handler_fn: ApprovalHandlerFn | None = None,
    # Extensions
    agent_file: Path | None = None,
    mcp_configs: list[MCPConfig] | None = None,
    skills_dir: Path | None = None,
    # Loop control
    max_steps_per_turn: int | None = None,
    max_retries_per_step: int | None = None,
    max_ralph_iterations: int | None = None,
    # Output control
    final_message_only: bool = False,
) -> AsyncGenerator[Message, None]:
    """One-shot prompt without session persistence. Returns a Message stream."""

    if not yolo and approval_handler_fn is None:
        raise ValueError("Either yolo=True or approval_handler_fn must be provided")

    # Create a temporary Session
    async with await Session.create(
        work_dir=work_dir or Path.cwd(),
        config=config,
        model=model,
        thinking=thinking,
        yolo=yolo,  # Pass to Session so ApprovalRequest is auto-handled in yolo mode
        agent_file=agent_file,
        mcp_configs=mcp_configs,
        skills_dir=skills_dir,
        max_steps_per_turn=max_steps_per_turn,
        max_retries_per_step=max_retries_per_step,
        max_ralph_iterations=max_ralph_iterations,
    ) as session:
        # Use Aggregator to convert WireMessage to Message
        # final_message_only corresponds to CLI --final-message-only, similar to FinalOnlyJsonPrinter
        aggregator = MessageAggregator(final_message_only=final_message_only)

        async for wire_msg in session.prompt(user_input):
            # Handle Approval
            if isinstance(wire_msg, ApprovalRequest):
                if yolo:
                    wire_msg.resolve("approve")
                else:
                    # Support both sync and async callbacks
                    result = approval_handler_fn(wire_msg)
                    if inspect.isawaitable(result):
                        result = await result
                    wire_msg.resolve(result)
                continue

            # Aggregate into Message
            if message := aggregator.feed(wire_msg):
                yield message

        # Output the last Message
        if message := aggregator.flush():
            yield message
```

### WireMessage → Message 聚合器

`prompt()` internally uses an aggregator to convert `WireMessage` stream to `Message` stream.
The logic follows `JsonPrinter` and `FinalOnlyJsonPrinter` in `kimi_cli/ui/print/visualize.py`:

```python
# kimi_agent_sdk/_aggregator.py
class MessageAggregator:
    """
    Aggregates WireMessage stream into Message stream.

    - final_message_only=False: Like JsonPrinter, outputs a Message at end of each step
    - final_message_only=True: Like FinalOnlyJsonPrinter, outputs only the last step's Message
    """

    def __init__(self, final_message_only: bool = False):
        self._final_message_only = final_message_only
        self._content_buffer: list[ContentPart] = []
        self._tool_calls: dict[str, ToolCall] = {}
        self._tool_results: dict[str, ToolResult] = {}

    def feed(self, msg: WireMessage) -> Message | None:
        """Feed a WireMessage, return aggregated Message if ready."""
        match msg:
            case StepBegin() | StepInterrupted():
                if self._final_message_only:
                    # final_message_only mode: clear buffer at step boundary without output
                    self._content_buffer.clear()
                    self._tool_calls.clear()
                    return None
                else:
                    # Normal mode: output aggregated content at step boundary
                    return self._flush()
            case ContentPart() as part:
                self._merge_content(part)
            case ToolCall() as call:
                self._tool_calls[call.id] = call
            case ToolCallPart() as part:
                # Merge into the last ToolCall
                ...
            case ToolResult() as result:
                self._tool_results[result.tool_call_id] = result
        return None

    def flush(self) -> Message | None:
        """Output buffered message (used at end of stream)."""
        return self._flush()

    def _flush(self) -> Message | None:
        """Output buffered message."""
        if not self._content_buffer and not self._tool_calls:
            return None

        # Construct assistant message
        message = Message(
            role="assistant",
            content=self._content_buffer,
            tool_calls=list(self._tool_calls.values()) or None,
        )

        # Clear buffer
        self._content_buffer = []
        self._tool_calls = {}

        return message
```

## 注意事项

1. **两层 API 的选择**：
   - `prompt()` 返回 `Message`，适合只关心内容输出的场景
   - `Session.prompt()` 返回 `WireMessage`，适合需要完整控制（手动处理 Approval、监控工具调用）的场景

2. **Approval 处理**：
   - 高层 API（`prompt()`）：必须通过 `yolo=True` 或 `approval_handler_fn` 处理
   - 低层 API（`Session.prompt()`）：必须在消息流中手动处理 `ApprovalRequest`，否则会永久阻塞

3. **会话隔离**：每个 `Session` 实例对应一个独立的会话。`prompt()` 函数每次调用创建新的临时会话。

4. **资源清理**：使用 `Session` 类时，务必调用 `close()` 或使用 `async with` 确保资源正确释放。

5. **线程安全**：SDK 的异步方法不是线程安全的，应在同一事件循环中使用。

6. **日志控制**：SDK 默认禁用日志输出。如需调试，可通过 `loguru` 启用：
   ```python
   from loguru import logger
   logger.enable("kimi_cli")
   ```

## 后续计划

- [ ] 支持同步 API（通过 `asyncio.run` 封装）
- [ ] 添加 Webhook 回调支持
- [ ] 支持自定义工具注册
- [ ] 添加 OpenTelemetry 集成
- [ ] 提供 CLI 工具的 Python 绑定（如 `/commit`、`/review-pr` 等）

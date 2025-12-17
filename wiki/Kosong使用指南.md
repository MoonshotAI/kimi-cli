# Kosong 使用指南

## 概述

Kimi CLI 项目使用 Kosong 作为其核心的 LLM（大语言模型）框架。Kosong 是一个自定义的 LLM 框架，提供了统一的聊天提供商接口、工具系统和消息处理能力。

## Kosong 在项目中的角色

### 1. 核心依赖

```toml
# pyproject.toml
dependencies = [
    "kosong[contrib]==0.33.0",
    # ... 其他依赖
]
```

### 2. 架构组件

Kosong 在 Kimi CLI 中承担以下核心功能：

- **聊天提供商抽象层**：统一不同 LLM 提供商的接口
- **工具系统**：提供可扩展的工具执行框架
- **消息处理**：处理多模态消息（文本、图像、音频等）
- **步骤执行**：管理 LLM 推理和工具调用的完整流程

## 支持的 LLM 提供商

项目通过 Kosong 支持多种 LLM 提供商：

### 内置提供商

1. **Kimi**（默认）
   ```python
   from kosong.chat_provider.kimi import Kimi
   ```

2. **Chaos**（测试用）
   ```python
   from kosong.chat_provider.chaos import ChaosChatProvider
   ```

### Contrib 扩展提供商

1. **OpenAI Legacy**
   ```python
   from kosong.contrib.chat_provider.openai_legacy import OpenAILegacy
   ```

2. **OpenAI Responses**
   ```python
   from kosong.contrib.chat_provider.openai_responses import OpenAIResponses
   ```

3. **Anthropic Claude**
   ```python
   from kosong.contrib.chat_provider.anthropic import Anthropic
   ```

4. **Google Gemini**
   ```python
   from kosong.contrib.chat_provider.google_genai import GoogleGenAI
   ```

## 核心使用模式

### 1. LLM 实例创建

```python
# src/kimi_cli/llm.py
def create_llm(provider: LLMProvider, model: LLMModel, *, session_id: str | None = None) -> LLM:
    match provider.type:
        case "kimi":
            from kosong.chat_provider.kimi import Kimi
            chat_provider = Kimi(
                model=model.model,
                base_url=provider.base_url,
                api_key=provider.api_key.get_secret_value(),
                default_headers={
                    "User-Agent": USER_AGENT,
                    **(provider.custom_headers or {}),
                },
            )
            if session_id:
                chat_provider = chat_provider.with_generation_kwargs(prompt_cache_key=session_id)
        # ... 其他提供商的处理
    
    return LLM(
        chat_provider=chat_provider,
        max_context_size=model.max_context_size,
        capabilities=_derive_capabilities(provider, model),
    )
```

### 2. 步骤执行

```python
# src/kimi_cli/soul/kimisoul.py
import kosong
from kosong import StepResult

async def _step(self) -> bool:
    result = await kosong.step(
        chat_provider.with_thinking(self._thinking_effort),
        self._agent.system_prompt,
        self._agent.toolset,
        self._context.history,
        on_message_part=wire_send,
        on_tool_result=wire_send,
    )
    # 处理结果...
```

### 3. 工具系统

```python
# src/kimi_cli/soul/toolset.py
from kosong.tooling import CallableTool2, Tool, Toolset
from kosong.tooling.simple import SimpleToolset

class KimiToolset:
    def __init__(self) -> None:
        self._inner = SimpleToolset()
    
    def add(self, tool: CallableTool2) -> None:
        self._inner += tool
    
    def handle(self, tool_call: ToolCall) -> HandleResult:
        token = current_tool_call.set(tool_call)
        try:
            return self._inner.handle(tool_call)
        finally:
            current_tool_call.reset(token)
```

### 4. 上下文压缩

```python
# src/kimi_cli/soul/compaction.py
from kosong.tooling.empty import EmptyToolset

async def compact(self, messages: Sequence[Message], llm: LLM) -> Sequence[Message]:
    result = await kosong.step(
        chat_provider=llm.chat_provider,
        system_prompt="You are a helpful assistant that compacts conversation context.",
        toolset=EmptyToolset(),
        history=[compact_message],
    )
    # 处理压缩结果...
```

## 工具开发

### 创建新工具

所有工具都继承自 Kosong 的 `CallableTool2`：

```python
# 示例：文件读取工具
from kosong.tooling import CallableTool2, ToolOk, ToolReturnValue
from pydantic import BaseModel, Field

class Params(BaseModel):
    path: str = Field(description="要读取的文件路径")

class ReadFile(CallableTool2[Params]):
    name: str = "ReadFile"
    description: str = "读取文件内容"
    params: type[Params] = Params
    
    async def __call__(self, params: Params) -> ToolReturnValue:
        # 实现工具逻辑
        return ToolOk(output="文件内容", message="读取成功")
```

### 工具注册

```python
# 在工具集初始化时添加
toolset = KimiToolset()
toolset.add(ReadFile(builtin_args))
```

## 消息处理

### 消息类型

Kosong 支持多种消息内容类型：

```python
from kosong.message import (
    ContentPart, 
    TextPart, 
    ImageURLPart, 
    AudioURLPart,
    ToolCallPart,
    ThinkPart
)

# 创建多模态消息
message = Message(
    role="user",
    content=[
        TextPart(text="请分析这张图片"),
        ImageURLPart(url="https://example.com/image.jpg"),
    ]
)
```

### 错误处理

```python
from kosong.chat_provider import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    ChatProviderError
)

def _is_retryable_error(exception: BaseException) -> bool:
    if isinstance(exception, (APIConnectionError, APITimeoutError)):
        return True
    return isinstance(exception, APIStatusError) and exception.status_code in (429, 500, 502, 503)
```

## 配置管理

### 环境变量覆盖

```python
def augment_provider_with_env_vars(provider: LLMProvider, model: LLMModel) -> dict[str, str]:
    applied: dict[str, str] = {}
    
    match provider.type:
        case "kimi":
            if base_url := os.getenv("KIMI_BASE_URL"):
                provider.base_url = base_url
                applied["KIMI_BASE_URL"] = base_url
            if api_key := os.getenv("KIMI_API_KEY"):
                provider.api_key = SecretStr(api_key)
                applied["KIMI_API_KEY"] = "******"
            # ... 其他配置
    
    return applied
```

### 模型能力管理

```python
# 支持的模型能力
type ModelCapability = Literal["image_in", "thinking"]

# 能力推导
def _derive_capabilities(provider: LLMProvider, model: LLMModel) -> set[ModelCapability]:
    capabilities = model.capabilities or set()
    if provider.type not in {"kimi", "_chaos"}:
        return capabilities
    
    if model.model == "kimi-for-coding" or "thinking" in model.model:
        capabilities.add("thinking")
    return capabilities
```

## 高级功能

### 1. 思考模式（Thinking）

```python
from kosong.chat_provider import ThinkingEffort

# 启用思考模式
chat_provider.with_thinking("high")

# 在步骤执行中使用
result = await kosong.step(
    chat_provider.with_thinking(self._thinking_effort),
    system_prompt,
    toolset,
    history,
)
```

### 2. 会话缓存

```python
# 为会话启用缓存
chat_provider = chat_provider.with_generation_kwargs(prompt_cache_key=session_id)
```

### 3. 重试机制

```python
import tenacity
from tenacity import retry_if_exception, stop_after_attempt, wait_exponential_jitter

@tenacity.retry(
    retry=retry_if_exception(self._is_retryable_error),
    wait=wait_exponential_jitter(initial=0.3, max=5, jitter=0.5),
    stop=stop_after_attempt(3),
    reraise=True,
)
async def _kosong_step_with_retry() -> StepResult:
    return await kosong.step(...)
```

## 最佳实践

### 1. 类型安全

```python
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from kosong.tooling import Toolset
    
    def type_check(kimi_toolset: KimiToolset):
        _: Toolset = kimi_toolset
```

### 2. 上下文管理

```python
# 使用上下文变量管理当前工具调用
from contextvars import ContextVar

current_tool_call = ContextVar[ToolCall | None]("current_tool_call", default=None)

def get_current_tool_call_or_none() -> ToolCall | None:
    return current_tool_call.get()
```

### 3. 异步处理

所有 Kosong 操作都是异步的，确保正确使用 `async/await`：

```python
async def process_step():
    result = await kosong.step(...)
    tool_results = await result.tool_results()
    # 处理结果...
```

## 总结

Kosong 为 Kimi CLI 提供了一个强大而灵活的 LLM 框架，其主要优势包括：

1. **统一的提供商接口**：轻松切换不同的 LLM 提供商
2. **可扩展的工具系统**：支持自定义工具开发
3. **多模态消息支持**：处理文本、图像、音频等多种内容类型
4. **高级功能**：思考模式、会话缓存、自动重试等
5. **类型安全**：完整的类型注解支持

通过合理使用 Kosong 的各种功能，Kimi CLI 能够提供一个功能丰富、稳定可靠的 AI 编程助手体验。

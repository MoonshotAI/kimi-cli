import json
import os
import random
from collections.abc import AsyncIterator, Sequence
from typing import TYPE_CHECKING, Any

import httpx
from pydantic import BaseModel

from kosong.chat_provider import (
    ChatProvider,
    ChatProviderError,
    StreamedMessage,
    StreamedMessagePart,
    ThinkingEffort,
    TokenUsage,
)
from kosong.message import Message, ToolCall, ToolCallPart
from kosong.tooling import Tool

if TYPE_CHECKING:

    def type_check(
        chaos: "ChaosChatProvider",
    ):
        _: ChatProvider = chaos


class ChaosConfig(BaseModel):
    """Configuration for chaos provider."""

    error_probability: float = 0.3
    error_types: list[int] = [429, 500, 502, 503]
    retry_after: int = 2
    seed: int | None = None
    corrupt_tool_call_probability: float = 0.1

    @classmethod
    def from_env(cls) -> "ChaosConfig":
        """Create config from environment variables."""
        seed_str = os.getenv("CHAOS_SEED")
        return cls(
            error_probability=float(os.getenv("CHAOS_ERROR_PROBABILITY", "0.3")),
            error_types=[
                int(x.strip()) for x in os.getenv("CHAOS_ERROR_TYPES", "429,500,502,503").split(",")
            ],
            retry_after=int(os.getenv("CHAOS_RETRY_AFTER", "2")),
            seed=int(seed_str) if seed_str else None,
            corrupt_tool_call_probability=float(
                os.getenv("CHAOS_CORRUPT_TOOL_CALL_PROBABILITY", "0.1")
            ),
        )


class ChaosTransport(httpx.AsyncBaseTransport):
    """HTTP transport that randomly injects errors."""

    def __init__(self, wrapped_transport: httpx.AsyncBaseTransport, config: ChaosConfig):
        self._wrapped = wrapped_transport
        self._config = config
        self._rng = random.Random(config.seed)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._should_inject_error():
            error_code = self._rng.choice(self._config.error_types)
            return self._create_error_response(request, error_code)

        return await self._wrapped.handle_async_request(request)

    def _should_inject_error(self) -> bool:
        return self._rng.random() < self._config.error_probability

    def _create_error_response(self, request: httpx.Request, status_code: int) -> httpx.Response:
        error_messages = {
            429: {"error": {"code": "rate_limit_exceeded", "message": "Rate limit exceeded"}},
            500: {"error": {"code": "internal_error", "message": "Internal server error"}},
            502: {"error": {"code": "bad_gateway", "message": "Bad gateway"}},
            503: {
                "error": {
                    "code": "service_unavailable",
                    "message": "Service temporarily unavailable",
                }
            },
        }

        content = json.dumps(
            error_messages.get(status_code, {"error": {"message": "Unknown error"}})
        )
        headers = {"content-type": "application/json"}

        if status_code == 429:
            headers["retry-after"] = str(self._config.retry_after)

        return httpx.Response(
            status_code=status_code,
            headers=headers,
            content=content.encode(),
            request=request,
        )


class ChaosChatProvider:
    """Wrap a chat provider and inject chaos into its HTTP transport and streamed tool calls."""

    def __init__(self, provider: ChatProvider, chaos_config: ChaosConfig | None = None):
        self._provider = provider
        self._chaos_config = chaos_config or ChaosConfig.from_env()
        self.name: str = provider.name
        self._monkey_patch_client()

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> "ChaosStreamedMessage":
        base_stream = await self._provider.generate(system_prompt, tools, history)
        return ChaosStreamedMessage(base_stream, self._chaos_config)

    def _monkey_patch_client(self):
        """
        Inject chaos transport into providers backed by httpx AsyncBaseTransport.

        Supported today (explicit list):
        - Kimi
        - OpenAILegacy
        - Anthropic

        The provider must expose an AsyncOpenAI/Anthropic/httpx client via `.client`,
        `.client._client`, or `._client`. Providers without an accessible httpx transport
        will raise ChatProviderError.
        """
        transport_owner = self._find_transport_owner()
        transport = getattr(transport_owner, "_transport", None)
        if not isinstance(transport, httpx.AsyncBaseTransport):
            raise ChatProviderError(
                "ChaosChatProvider only supports providers backed by httpx.AsyncBaseTransport"
            )

        chaos_transport = ChaosTransport(transport, self._chaos_config)
        transport_owner._transport = chaos_transport  # pyright: ignore[reportPrivateUsage]

    def _find_transport_owner(self) -> Any:
        """Locate the object that owns the httpx transport."""
        candidates: list[Any] = []

        client = getattr(self._provider, "client", None)
        if client is not None:
            candidates.append(client)
            raw_client = getattr(client, "_client", None)
            if raw_client is not None:
                candidates.append(raw_client)

        inner_client = getattr(self._provider, "_client", None)
        if inner_client is not None:
            candidates.append(inner_client)

        for owner in candidates:
            if hasattr(owner, "_transport"):
                return owner
            nested = getattr(owner, "_client", None)
            if nested and hasattr(nested, "_transport"):
                return nested

        raise ChatProviderError(
            "ChaosChatProvider only supports providers backed by httpx.AsyncBaseTransport"
        )

    @property
    def model_name(self) -> str:
        if (
            self._chaos_config.error_probability > 0
            or self._chaos_config.corrupt_tool_call_probability > 0
        ):
            return f"chaos({self._provider.model_name})"
        return self._provider.model_name

    def with_thinking(self, effort: ThinkingEffort) -> "ChaosChatProvider":
        return ChaosChatProvider(self._provider.with_thinking(effort), self._chaos_config)

    @classmethod
    def for_kimi(
        cls, chaos_config: ChaosConfig | None = None, **kwargs: Any
    ) -> "ChaosChatProvider":
        """Helper to wrap a Kimi provider without changing caller sites."""
        from kosong.chat_provider.kimi import Kimi

        return cls(Kimi(**kwargs), chaos_config=chaos_config)


class ChaosStreamedMessage:
    """Stream wrapper that injects chaos into tool calls."""

    def __init__(self, wrapped: StreamedMessage, config: ChaosConfig):
        self._wrapped = wrapped
        self._config = config
        self._rng = random.Random(config.seed)
        self._iterator = wrapped.__aiter__()

    def __aiter__(self) -> AsyncIterator[StreamedMessagePart]:
        return self

    async def __anext__(self) -> StreamedMessagePart:
        part = await self._iterator.__anext__()
        return self._maybe_corrupt_tool_call(part)

    @property
    def id(self) -> str | None:
        return self._wrapped.id

    @property
    def usage(self) -> TokenUsage | None:
        return self._wrapped.usage

    def _should_corrupt_tool_call(self) -> bool:
        probability = self._config.corrupt_tool_call_probability
        return probability > 0 and self._rng.random() < probability

    def _maybe_corrupt_tool_call(self, part: StreamedMessagePart) -> StreamedMessagePart:
        if not self._should_corrupt_tool_call():
            return part
        if isinstance(part, ToolCall):
            return self._corrupt_tool_call(part)
        if isinstance(part, ToolCallPart):
            return self._corrupt_tool_call_part(part)
        return part

    def _corrupt_tool_call(self, tool_call: ToolCall) -> StreamedMessagePart:
        arguments = tool_call.function.arguments
        if arguments is None or not arguments.endswith("}"):
            return tool_call
        corrupted = tool_call.model_copy(deep=True)
        corrupted.function.arguments = arguments[:-1]
        return corrupted

    def _corrupt_tool_call_part(self, part: ToolCallPart) -> StreamedMessagePart:
        arguments = part.arguments_part
        if arguments is None or not arguments.endswith("}"):
            return part
        corrupted = part.model_copy(deep=True)
        corrupted.arguments_part = arguments[:-1]
        return corrupted


if __name__ == "__main__":

    async def _dev_main_anthropic():
        from dotenv import load_dotenv

        from kosong.contrib.chat_provider.anthropic import Anthropic
        from kosong.message import Message, TextPart

        load_dotenv()

        provider = Anthropic(
            model="claude-3-5-sonnet-latest",
            api_key=os.getenv("ANTHROPIC_API_KEY"),
            default_max_tokens=64,
            stream=True,
        )
        chat = ChaosChatProvider(
            provider,
            ChaosConfig(
                error_probability=0.0,
                corrupt_tool_call_probability=0.2,
                seed=42,
            ),
        )
        history = [Message(role="user", content=[TextPart(text="Say hello briefly.")])]
        stream = await chat.generate(system_prompt="", tools=[], history=history)
        async for part in stream:
            print(part.model_dump(exclude_none=True))
        print("id:", stream.id)
        print("usage:", stream.usage)

    import asyncio

    asyncio.run(_dev_main_anthropic())

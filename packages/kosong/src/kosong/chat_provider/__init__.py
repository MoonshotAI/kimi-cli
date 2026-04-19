from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import TYPE_CHECKING, Literal, Protocol, Self, runtime_checkable

from pydantic import BaseModel

from kosong.message import ContentPart, Message, ToolCall, ToolCallPart
from kosong.tooling import Tool

if TYPE_CHECKING:
    import httpx


@runtime_checkable
class ChatProvider(Protocol):
    """The interface of chat providers."""

    name: str
    """
    The name of the chat provider.
    """

    @property
    def model_name(self) -> str:
        """
        The name of the model to use.
        """
        ...

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        """
        The current thinking effort level. Returns None if not explicitly set.
        """
        ...

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> StreamedMessage:
        """
        Generate a new message based on the given system prompt, tools, and history.

        Raises:
            APIConnectionError: If the API connection fails.
            APITimeoutError: If the API request times out.
            APIStatusError: If the API returns a status code of 4xx or 5xx.
            ChatProviderError: If any other recognized chat provider error occurs.
        """
        ...

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        """
        Return a copy of self configured with the given thinking effort.
        If the chat provider does not support thinking, simply return a copy of self.
        """
        ...


@runtime_checkable
class RetryableChatProvider(Protocol):
    """Optional interface for providers that can recover from retryable transport errors."""

    def on_retryable_error(self, error: BaseException) -> bool:
        """
        Try to recover provider transport state after a retryable error.

        Returns:
            bool: Whether recovery action was performed.
        """
        ...


type StreamedMessagePart = ContentPart | ToolCall | ToolCallPart


@runtime_checkable
class StreamedMessage(Protocol):
    """The interface of streamed messages."""

    def __aiter__(self) -> AsyncIterator[StreamedMessagePart]:
        """Create an async iterator from the stream."""
        ...

    @property
    def id(self) -> str | None:
        """The ID of the streamed message."""
        ...

    @property
    def usage(self) -> TokenUsage | None:
        """The token usage of the streamed message."""
        ...


class TokenUsage(BaseModel):
    """Token usage statistics."""

    input_other: int
    """Input tokens excluding `input_cache_read` and `input_cache_creation`."""
    output: int
    """Total output tokens."""
    input_cache_read: int = 0
    """Cached input tokens."""
    input_cache_creation: int = 0
    """Input tokens used for cache creation. For now, only Anthropic API supports this."""

    @property
    def total(self) -> int:
        """Total tokens used, including input and output tokens."""
        return self.input + self.output

    @property
    def input(self) -> int:
        """Total input tokens, including cached and uncached tokens."""
        return self.input_other + self.input_cache_read + self.input_cache_creation


type ThinkingEffort = Literal["off", "low", "medium", "high", "xhigh", "max"]
"""The effort level for thinking.

Support for levels above ``high`` varies by provider:

- **Anthropic**: ``xhigh`` is accepted only on Claude Opus 4.7; ``max`` is
  accepted on Mythos, Opus 4.7/4.6, and Sonnet 4.6. Unsupported levels are
  clamped down to ``high``.
- **OpenAI**: ``xhigh`` is accepted natively for reasoning-capable models
  after ``gpt-5.1-codex-max`` and passes through unchanged. ``max`` is
  Anthropic-specific and clamps to ``xhigh`` (OpenAI's ceiling).
- **Kimi / Gemini**: ``xhigh`` and ``max`` clamp to ``high`` (no native
  support).
"""


class ChatProviderError(Exception):
    """The error raised by a chat provider."""

    def __init__(self, message: str):
        super().__init__(message)


class APIConnectionError(ChatProviderError):
    """The error raised when the API connection fails."""


class APITimeoutError(ChatProviderError):
    """The error raised when the API request times out."""


class APIStatusError(ChatProviderError):
    """The error raised when the API returns a status code of 4xx or 5xx."""

    status_code: int
    request_id: str | None

    def __init__(self, status_code: int, message: str, *, request_id: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.request_id = request_id


class APIEmptyResponseError(ChatProviderError):
    """The error raised when the API returns an empty response."""


def convert_httpx_error(error: httpx.HTTPError) -> ChatProviderError:
    """Convert an httpx transport error to the corresponding ChatProviderError.

    This is a shared utility for all chat providers. SDK-specific exceptions
    (e.g. AnthropicError, OpenAIError) should be handled by each provider's
    own conversion logic; only raw httpx exceptions that leak through
    (typically during streaming) should be routed here.
    """
    import httpx

    if isinstance(error, httpx.TimeoutException):
        return APITimeoutError(str(error))
    if isinstance(error, (httpx.NetworkError, httpx.RemoteProtocolError)):
        return APIConnectionError(str(error))
    if isinstance(error, httpx.HTTPStatusError):
        req_id = error.response.headers.get("x-request-id")
        return APIStatusError(error.response.status_code, str(error), request_id=req_id)
    return ChatProviderError(f"HTTP error: {error}")

from __future__ import annotations

import copy
from collections.abc import AsyncIterator, Sequence
from typing import TYPE_CHECKING, Self

from kosong.chat_provider import (
    ChatProvider,
    ChatProviderError,
    StreamedMessage,
    StreamedMessagePart,
    ThinkingEffort,
    TokenUsage,
)
from kosong.chat_provider.echo.dsl import parse_echo_script
from kosong.message import Message
from kosong.tooling import Tool

if TYPE_CHECKING:

    def type_check(echo: EchoChatProvider):
        _: ChatProvider = echo


class EchoChatProvider:
    """
    A test-only chat provider that streams parts described by a tiny DSL.

    The DSL lives in the content of the last message in `history` and is made of lines in the
    form `kind: payload`. Empty lines, comment lines starting with `#`, and markdown fences
    starting with ``` are ignored. Supported kinds:

    - `id`: sets the streamed message id.
    - `usage`: token usage, e.g. `usage: {"input_other": 10, "output": 2}` or
      `usage: input_other=1 output=2 input_cache_read=3`.
    - `text`: a text chunk.
    - `think`: a thinking chunk.
    - `image_url`: either a raw URL or `{"url": "...", "id": "opt"}`.
    - `audio_url`: either a raw URL or `{"url": "...", "id": "opt"}`.
    - `video_url`: either a raw URL or `{"url": "...", "id": "opt"}`.
    - `tool_call`: a JSON or key/value object. Fields: `id`, `name` (or `function.name`),
      optional `arguments`/`function.arguments`, optional `extras`.
    - `tool_call_part`: a string/JSON with `arguments_part`; `null` becomes `None`.

    Example:

    ```
    id: echo-42
    usage: {"input_other": 10, "output": 2}
    think: thinking...
    text: Hello,
    text:  world!
    image_url: {"url": "https://example.com/image.png", "id": "img-1"}
    tool_call: {"id": "call-1", "name": "search", "arguments": "{\\"query"}
    tool_call_part: {"arguments_part": "\\": \\"what time is"}
    tool_call_part: {"arguments_part": " it?\\"}"}
    ```
    """

    name = "echo"

    @property
    def model_name(self) -> str:
        return "echo"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> EchoStreamedMessage:
        if not history:
            raise ChatProviderError("EchoChatProvider requires at least one message in history.")
        if history[-1].role != "user":
            raise ChatProviderError("EchoChatProvider expects the last history message to be user.")

        script_text = history[-1].extract_text()
        parts, message_id, usage = parse_echo_script(script_text)
        if not parts:
            raise ChatProviderError("EchoChatProvider DSL produced no streamable parts.")
        return EchoStreamedMessage(parts=parts, message_id=message_id, usage=usage)

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        # Thinking effort is irrelevant to the echo provider; return a shallow copy to
        # satisfy the protocol and keep the instance immutable.
        return copy.copy(self)


class EchoStreamedMessage(StreamedMessage):
    """Streamed message for EchoChatProvider."""

    def __init__(
        self,
        *,
        parts: list[StreamedMessagePart],
        message_id: str | None,
        usage: TokenUsage | None,
    ):
        self._iter = self._to_stream(parts)
        self._id = message_id
        self._usage = usage

    def __aiter__(self) -> AsyncIterator[StreamedMessagePart]:
        return self

    async def __anext__(self) -> StreamedMessagePart:
        return await self._iter.__anext__()

    async def _to_stream(
        self, parts: list[StreamedMessagePart]
    ) -> AsyncIterator[StreamedMessagePart]:
        for part in parts:
            yield part

    @property
    def id(self) -> str | None:
        return self._id

    @property
    def usage(self) -> TokenUsage | None:
        return self._usage

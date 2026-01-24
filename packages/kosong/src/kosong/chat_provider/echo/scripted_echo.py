from __future__ import annotations

import copy
import json
from collections import deque
from collections.abc import AsyncIterator, Iterable, Sequence
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

    def type_check(scripted: ScriptedEchoChatProvider):
        _: ChatProvider = scripted


class ScriptedEchoChatProvider:
    """
    A test-only chat provider that consumes a queue of echo DSL scripts per call.
    """

    name = "scripted_echo"

    def __init__(self, scripts: Iterable[str], *, trace: bool = False):
        self._scripts = deque(scripts)
        self._turn = 0
        self._trace = trace

    @property
    def model_name(self) -> str:
        return "scripted_echo"

    @property
    def thinking_effort(self) -> ThinkingEffort | None:
        return None

    async def generate(
        self,
        system_prompt: str,
        tools: Sequence[Tool],
        history: Sequence[Message],
    ) -> ScriptedEchoStreamedMessage:
        if not self._scripts:
            raise ChatProviderError(f"ScriptedEchoChatProvider exhausted at turn {self._turn + 1}.")
        script_text = self._scripts.popleft()
        if self._trace:
            script_json = json.dumps(script_text)
            print(f"SCRIPTED_ECHO TURN {self._turn + 1}: {script_json}")
        self._turn += 1
        parts, message_id, usage = parse_echo_script(script_text)
        if not parts:
            raise ChatProviderError("ScriptedEchoChatProvider DSL produced no streamable parts.")
        return ScriptedEchoStreamedMessage(parts=parts, message_id=message_id, usage=usage)

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        copied = copy.copy(self)
        copied._scripts = deque(self._scripts)
        return copied


class ScriptedEchoStreamedMessage(StreamedMessage):
    """Streamed message for ScriptedEchoChatProvider."""

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

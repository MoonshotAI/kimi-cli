from __future__ import annotations

import copy
import json
from collections.abc import AsyncIterator, Sequence
from typing import TYPE_CHECKING, Any, Self, cast

from kosong.chat_provider import (
    ChatProvider,
    ChatProviderError,
    StreamedMessage,
    StreamedMessagePart,
    ThinkingEffort,
    TokenUsage,
)
from kosong.message import (
    AudioURLPart,
    ImageURLPart,
    Message,
    TextPart,
    ThinkPart,
    ToolCall,
    ToolCallPart,
    VideoURLPart,
)
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
        parts, message_id, usage = self._parse_script(script_text)
        if not parts:
            raise ChatProviderError("EchoChatProvider DSL produced no streamable parts.")
        return EchoStreamedMessage(parts=parts, message_id=message_id, usage=usage)

    def with_thinking(self, effort: ThinkingEffort) -> Self:
        # Thinking effort is irrelevant to the echo provider; return a shallow copy to
        # satisfy the protocol and keep the instance immutable.
        return copy.copy(self)

    def _parse_script(
        self, script: str
    ) -> tuple[list[StreamedMessagePart], str | None, TokenUsage | None]:
        parts: list[StreamedMessagePart] = []
        message_id: str | None = None
        usage: TokenUsage | None = None

        for lineno, raw_line in enumerate(script.splitlines(), start=1):
            line = raw_line.strip()
            if not line or line.startswith("#") or line.startswith("```"):
                continue
            if line.lower() == "echo":
                continue
            key, sep, payload = line.partition(":")
            if not sep:
                raise ChatProviderError(f"Invalid echo DSL at line {lineno}: {raw_line!r}")

            kind = key.strip().lower()
            payload = payload[1:] if payload.startswith(" ") else payload
            if kind == "id":
                message_id = self._strip_quotes(payload.strip())
                continue
            if kind == "usage":
                usage = self._parse_usage(payload)
                continue

            part = self._parse_part(kind, payload, lineno, raw_line)
            parts.append(part)

        return parts, message_id, usage

    def _parse_part(
        self, kind: str, payload: str, lineno: int, raw_line: str
    ) -> StreamedMessagePart:
        match kind:
            case "text":
                return TextPart(text=self._strip_quotes(payload))
            case "think":
                return ThinkPart(think=self._strip_quotes(payload))
            case "image_url":
                url, image_id = self._parse_url_payload(payload, kind)
                return ImageURLPart(image_url=ImageURLPart.ImageURL(url=url, id=image_id))
            case "audio_url":
                url, audio_id = self._parse_url_payload(payload, kind)
                return AudioURLPart(audio_url=AudioURLPart.AudioURL(url=url, id=audio_id))
            case "video_url":
                url, video_id = self._parse_url_payload(payload, kind)
                return VideoURLPart(video_url=VideoURLPart.VideoURL(url=url, id=video_id))
            case "tool_call":
                return self._parse_tool_call(payload, lineno, raw_line)
            case "tool_call_part":
                return self._parse_tool_call_part(payload)
            case _:
                raise ChatProviderError(
                    f"Unknown echo DSL kind '{kind}' at line {lineno}: {raw_line!r}"
                )

    def _parse_usage(self, payload: str) -> TokenUsage:
        mapping = self._parse_mapping(payload, context="usage")

        def _int_value(key: str) -> int:
            value = mapping.get(key, 0)
            try:
                return int(value)
            except (TypeError, ValueError):
                raise ChatProviderError(
                    f"Usage field '{key}' must be an integer, got {value!r}"
                ) from None

        return TokenUsage(
            input_other=_int_value("input_other"),
            output=_int_value("output"),
            input_cache_read=_int_value("input_cache_read"),
            input_cache_creation=_int_value("input_cache_creation"),
        )

    def _parse_url_payload(self, payload: str, kind: str) -> tuple[str, str | None]:
        value = self._parse_value(payload)
        if isinstance(value, dict):
            mapping = cast(dict[str, Any], value)
            url = mapping.get("url")
            if not isinstance(url, str):
                raise ChatProviderError(f"{kind} requires a url field, got {mapping!r}")
            content_id = mapping.get("id")
            if content_id is not None and not isinstance(content_id, str):
                raise ChatProviderError(f"{kind} id must be a string when provided.")
            return url, content_id
        if not isinstance(value, str):
            raise ChatProviderError(f"{kind} expects url string or object, got {value!r}")
        return value, None

    def _parse_tool_call(self, payload: str, lineno: int, raw_line: str) -> ToolCall:
        mapping = self._parse_mapping(payload, context="tool_call")
        function = mapping.get("function") if isinstance(mapping.get("function"), dict) else None

        tool_call_id = mapping.get("id")
        name = mapping.get("name") or (function.get("name") if function else None)
        arguments = mapping.get("arguments")
        extras = mapping.get("extras")

        if function:
            if arguments is None:
                arguments = function.get("arguments")
            if extras is None:
                extras = function.get("extras")

        if not isinstance(tool_call_id, str) or not isinstance(name, str):
            raise ChatProviderError(
                f"tool_call requires string id and name at line {lineno}: {raw_line!r}"
            )

        if arguments is not None and not isinstance(arguments, str):
            raise ChatProviderError(
                "tool_call.arguments must be a string at line "
                f"{lineno}, got {type(arguments).__name__}"
            )

        return ToolCall(
            id=tool_call_id,
            function=ToolCall.FunctionBody(name=name, arguments=arguments),
            extras=cast(dict[str, Any], extras) if isinstance(extras, dict) else None,
        )

    def _parse_tool_call_part(self, payload: str) -> ToolCallPart:
        value = self._parse_value(payload)
        if isinstance(value, dict):
            value = cast(dict[str, Any], value)
            arguments_part: Any | None = value.get("arguments_part")
        else:
            arguments_part = value
        if isinstance(arguments_part, (dict, list)):
            arguments_part = json.dumps(arguments_part, separators=(",", ":"))
        return ToolCallPart(arguments_part=None if arguments_part in (None, "") else arguments_part)

    def _parse_mapping(self, raw: str, *, context: str) -> dict[str, Any]:
        raw = raw.strip()
        try:
            loaded = json.loads(raw)
        except json.JSONDecodeError:
            loaded = None
        if isinstance(loaded, dict):
            return cast(dict[str, Any], loaded)
        if loaded is not None:
            raise ChatProviderError(f"{context} payload must be an object, got {loaded!r}")

        mapping: dict[str, Any] = {}
        for token in raw.replace(",", " ").split():
            if not token:
                continue
            if "=" not in token:
                raise ChatProviderError(f"Invalid token '{token}' in {context} payload.")
            key, value = token.split("=", 1)
            mapping[key.strip()] = self._parse_value(value.strip())

        if not mapping:
            raise ChatProviderError(f"{context} payload cannot be empty.")
        return mapping

    def _parse_value(self, raw: str) -> Any:
        raw = raw.strip()
        if not raw:
            return None
        lowered = raw.lower()
        if lowered in {"null", "none"}:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return self._strip_quotes(raw)

    def _strip_quotes(self, value: str) -> str:
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            return value[1:-1]
        return value


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

from __future__ import annotations

import json
from typing import Any, cast

from kosong.chat_provider import ChatProviderError, StreamedMessagePart, TokenUsage
from kosong.message import (
    AudioURLPart,
    ImageURLPart,
    TextPart,
    ThinkPart,
    ToolCall,
    ToolCallPart,
    VideoURLPart,
)


def parse_echo_script(
    script: str,
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
            message_id = _strip_quotes(payload.strip())
            continue
        if kind == "usage":
            usage = _parse_usage(payload)
            continue

        part = _parse_part(kind, payload, lineno, raw_line)
        parts.append(part)

    return parts, message_id, usage


def _parse_part(kind: str, payload: str, lineno: int, raw_line: str) -> StreamedMessagePart:
    match kind:
        case "text":
            return TextPart(text=_strip_quotes(payload))
        case "think":
            return ThinkPart(think=_strip_quotes(payload))
        case "image_url":
            url, image_id = _parse_url_payload(payload, kind)
            return ImageURLPart(image_url=ImageURLPart.ImageURL(url=url, id=image_id))
        case "audio_url":
            url, audio_id = _parse_url_payload(payload, kind)
            return AudioURLPart(audio_url=AudioURLPart.AudioURL(url=url, id=audio_id))
        case "video_url":
            url, video_id = _parse_url_payload(payload, kind)
            return VideoURLPart(video_url=VideoURLPart.VideoURL(url=url, id=video_id))
        case "tool_call":
            return _parse_tool_call(payload, lineno, raw_line)
        case "tool_call_part":
            return _parse_tool_call_part(payload)
        case _:
            raise ChatProviderError(
                f"Unknown echo DSL kind '{kind}' at line {lineno}: {raw_line!r}"
            )


def _parse_usage(payload: str) -> TokenUsage:
    mapping = _parse_mapping(payload, context="usage")

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


def _parse_url_payload(payload: str, kind: str) -> tuple[str, str | None]:
    value = _parse_value(payload)
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


def _parse_tool_call(payload: str, lineno: int, raw_line: str) -> ToolCall:
    mapping = _parse_mapping(payload, context="tool_call")
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
            f"tool_call.arguments must be a string at line {lineno}, got {type(arguments).__name__}"
        )

    return ToolCall(
        id=tool_call_id,
        function=ToolCall.FunctionBody(name=name, arguments=arguments),
        extras=cast(dict[str, Any], extras) if isinstance(extras, dict) else None,
    )


def _parse_tool_call_part(payload: str) -> ToolCallPart:
    value = _parse_value(payload)
    if isinstance(value, dict):
        value = cast(dict[str, Any], value)
        arguments_part: Any | None = value.get("arguments_part")
    else:
        arguments_part = value
    if isinstance(arguments_part, (dict, list)):
        arguments_part = json.dumps(arguments_part, separators=(",", ":"))
    return ToolCallPart(arguments_part=None if arguments_part in (None, "") else arguments_part)


def _parse_mapping(raw: str, *, context: str) -> dict[str, Any]:
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
        mapping[key.strip()] = _parse_value(value.strip())

    if not mapping:
        raise ChatProviderError(f"{context} payload cannot be empty.")
    return mapping


def _parse_value(raw: str) -> Any:
    raw = raw.strip()
    if not raw:
        return None
    lowered = raw.lower()
    if lowered in {"null", "none"}:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return _strip_quotes(raw)


def _strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value

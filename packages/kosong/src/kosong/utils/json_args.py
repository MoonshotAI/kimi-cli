"""Decode tool-call arguments, handling double-encoded JSON strings.

Some LLM providers (notably the Moonshot API) return ``function.arguments``
where nested array/object values are themselves JSON strings. A single
``json.loads`` leaves these inner values as strings, which then fail Pydantic
validation (e.g. ``Input should be a valid list``).

:func:`decode_tool_arguments` parses the outer payload and recursively unwraps
any string that itself decodes to a ``dict`` or ``list``. Scalar strings
(``"42"``, ``"true"``, ``"hello"``) are left untouched so genuine string fields
are never corrupted.

Fast-path: strings are only parsed if their first non-whitespace character is
``[`` or ``{``, avoiding unnecessary ``json.loads`` calls on typical non-JSON
string values.
"""

from __future__ import annotations

import json
from typing import cast

from kosong.utils.typing import JsonType

__all__ = ["decode_tool_arguments"]


_MAX_UNWRAP_DEPTH = 100  # guard against adversarial deeply-nested payloads


def _unwrap(value: object, depth: int = 0) -> object:
    if isinstance(value, dict):
        if depth >= _MAX_UNWRAP_DEPTH:
            return value
        return {k: _unwrap(v, depth + 1) for k, v in cast("dict[str, object]", value).items()}
    if isinstance(value, list):
        if depth >= _MAX_UNWRAP_DEPTH:
            return value
        return [_unwrap(x, depth + 1) for x in cast("list[object]", value)]
    if isinstance(value, str):
        # Fast-path: skip strings that cannot be JSON objects/arrays.
        # The lstrip handles leading whitespace (rare but valid).
        stripped = value.lstrip()
        if not stripped or stripped[0] not in ("[", "{"):
            return value
        if depth >= _MAX_UNWRAP_DEPTH:
            return value
        try:
            parsed = json.loads(value, strict=False)
        except (json.JSONDecodeError, ValueError):
            return value
        if isinstance(parsed, (dict, list)):
            return _unwrap(parsed, depth + 1)
        return value
    return value


def decode_tool_arguments(raw: str | None) -> JsonType:
    """Parse tool-call arguments, recursively unwrapping double-encoded values.

    ``None``/empty strings coerce to ``{}`` (preserving the historical guard).
    The outer payload is parsed first; ``json.JSONDecodeError`` is re-raised so
    callers can surface ``ToolParseError``. After parsing, inner strings that
    decode to dicts or lists are recursively unwrapped.
    """
    if raw is None or raw == "":
        raw = "{}"
    parsed = json.loads(raw, strict=False)
    return cast(JsonType, _unwrap(parsed))

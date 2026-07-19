"""Tool-call argument decoding, including double-encoding unwrap.

Some chat-completion providers (notably the Moonshot API) return
``function.arguments`` whose inner array/object values are themselves JSON
strings — e.g. ``{"todos": "[{\\"title\\":\\"x\\"}]"}``. A single
``json.loads`` leaves the inner value as a string, which then fails Pydantic
validation (``Input should be a valid list``). This module provides
:func:`decode_tool_arguments`, which parses the outer payload and recursively
unwraps any string that itself decodes to a ``dict`` or ``list``.

Guarantees:
- The OUTER ``json.loads`` re-raises ``json.JSONDecodeError`` so callers can
  surface ``ToolParseError`` (preserves today's contract).
- Inner unwrap is best-effort: a string that fails to parse, or parses to a
  scalar (``int``/``float``/``bool``/``None``), is left UNCHANGED. The
  dict-or-list gate protects genuine string fields whose value happens to be
  valid JSON (e.g. a ``count_str`` field set to ``"42"``).
- Recursion terminates: ``_unwrap`` only re-enters when a string parses to a
  dict/list; non-string leaves and scalar parses return immediately.
"""

from __future__ import annotations

import json
from typing import cast

from kosong.utils.typing import JsonType

__all__ = ["decode_tool_arguments"]


def _unwrap(value: object) -> object:
    if isinstance(value, dict):
        return {k: _unwrap(v) for k, v in cast("dict[str, object]", value).items()}
    if isinstance(value, list):
        return [_unwrap(x) for x in cast("list[object]", value)]
    if isinstance(value, str):
        try:
            parsed = json.loads(value, strict=False)
        except (json.JSONDecodeError, ValueError):
            return value
        if isinstance(parsed, (dict, list)):
            return _unwrap(parsed)
        return value
    return value


def decode_tool_arguments(raw: str | dict | None) -> JsonType:
    """Parse tool-call arguments, recursively unwrapping double-encoded values.

    Coerces ``None``/empty to ``"{}"`` (preserving the historical guard), then
    parses the outer payload and recursively unwraps inner strings that decode
    to a dict or list. Re-raises ``json.JSONDecodeError`` on outer malformed
    input so callers can surface ``ToolParseError``.
    """
    if raw is None or raw == "":
        raw = "{}"
    if isinstance(raw, dict):
        return cast(JsonType, _unwrap(raw))
    parsed = json.loads(raw, strict=False)
    return cast(JsonType, _unwrap(parsed))

"""Tool-call argument decoding and double-encoding unwrap.

Some chat-completion providers (notably the Moonshot API) return
``function.arguments`` whose inner array/object values are themselves JSON
strings — e.g. ``{"todos": "[{\\"title\\":\\"x\\"}]"}``. A single
``json.loads`` leaves the inner value as a string, which then fails
validation.

Two helpers with deliberately separate jobs:

- :func:`decode_tool_arguments` only parses the outer payload. It never
  rewrites values: a string-typed parameter whose content happens to be
  valid JSON (e.g. writing a ``package.json``) must reach the tool
  byte-for-byte, so promotion cannot happen at decode time where the
  parameter schema is unknown.
- :func:`unwrap_double_encoded` performs the recursive promotion. Call it
  only after validation of the original arguments has failed — the strings
  are then promoted so the retry can succeed. Validating first keeps the
  unwrap schema-aware without plumbing types into the decoder.
"""

from __future__ import annotations

import json
from typing import cast

from kosong.utils.typing import JsonType

__all__ = ["decode_tool_arguments", "unwrap_double_encoded"]


def unwrap_double_encoded(value: object) -> object:
    """Recursively promote strings that parse to a ``dict`` or ``list``.

    Strings that fail to parse, or parse to a scalar
    (``int``/``float``/``bool``/``None``), are left UNCHANGED, which protects
    genuine string fields whose value looks like JSON (e.g. ``"42"``).
    Recursion terminates: it only re-enters when a string parses to a
    dict/list; non-string leaves and scalar parses return immediately.
    """
    if isinstance(value, dict):
        return {k: unwrap_double_encoded(v) for k, v in cast("dict[str, object]", value).items()}
    if isinstance(value, list):
        return [unwrap_double_encoded(x) for x in cast("list[object]", value)]
    if isinstance(value, str):
        try:
            parsed = json.loads(value, strict=False)
        except (json.JSONDecodeError, ValueError):
            return value
        if isinstance(parsed, (dict, list)):
            return unwrap_double_encoded(parsed)
        return value
    return value


def decode_tool_arguments(raw: str | dict | None) -> JsonType:
    """Parse tool-call arguments without rewriting any value.

    Coerces ``None``/empty to ``"{}"`` (preserving the historical guard), then
    parses the outer payload. Re-raises ``json.JSONDecodeError`` on malformed
    input so callers can surface ``ToolParseError``.

    Double-encoded inner values are NOT unwrapped here. Unwrap with
    :func:`unwrap_double_encoded` only after validating the parsed arguments
    failed — see the module docstring for why.
    """
    if raw is None or raw == "":
        raw = "{}"
    if isinstance(raw, dict):
        return cast(JsonType, raw)
    return cast(JsonType, json.loads(raw, strict=False))

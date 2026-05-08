from __future__ import annotations

import json
from typing import Literal, cast

from kosong.utils.typing import JsonType

type ToolMessageConversion = Literal["extract_text"]


def parse_tool_call_arguments(arguments: str | None) -> dict[str, object]:
    if not arguments:
        return {}
    try:
        parsed: JsonType = json.loads(arguments, strict=False)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return cast(dict[str, object], parsed)


def sanitize_tool_call_arguments(arguments: str | None) -> str:
    return json.dumps(parse_tool_call_arguments(arguments), ensure_ascii=False)

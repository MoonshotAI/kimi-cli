"""Tests for `_convert_tool` in the Kimi chat provider.

These guard the Moonshot-specific schema quirk: Moonshot rejects tool
parameter schemas whose nested properties omit `type`, even though such
schemas are valid JSON Schema and accepted by OpenAI/Anthropic. The Kimi
provider normalizes schemas locally so MCP tools from servers that emit
type-less properties (e.g. some JetBrains MCP tools) keep working.
"""

from kosong.chat_provider.kimi import _convert_tool  # pyright: ignore[reportPrivateUsage]
from kosong.tooling import Tool


def _jetbrains_like_tool() -> Tool:
    """A Tool shaped like the real jetbrains-rider MCP tool that triggered
    the Moonshot 400 — `truncateMode` has `enum` but no `type`."""
    return Tool(
        name="jetbrains__get_file_text_by_path",
        description="Read file text from a JetBrains-rider project.",
        parameters={
            "type": "object",
            "properties": {
                "pathInProject": {"type": "string", "description": "The path."},
                "truncateMode": {
                    "description": "How to truncate long outputs.",
                    "enum": ["smart", "full", "none"],
                },
            },
            "required": ["pathInProject"],
        },
    )


def test_convert_tool_fills_missing_property_type() -> None:
    converted = _convert_tool(_jetbrains_like_tool())
    parameters = converted["function"].get("parameters")
    assert isinstance(parameters, dict)
    props = parameters["properties"]
    assert isinstance(props, dict)
    # truncateMode had no `type`; after conversion it must have one.
    assert props["truncateMode"]["type"] == "string"
    # Existing fields preserved.
    assert props["truncateMode"]["enum"] == ["smart", "full", "none"]
    assert props["pathInProject"]["type"] == "string"


def test_convert_tool_does_not_mutate_source_tool() -> None:
    tool = _jetbrains_like_tool()
    _convert_tool(tool)
    # The source tool's parameters must still lack `type` on truncateMode —
    # `_convert_tool` must copy, not mutate in place.
    assert "type" not in tool.parameters["properties"]["truncateMode"]


def test_convert_tool_preserves_builtin_function_shape() -> None:
    """Kimi builtin functions (names starting with `$`) don't carry
    parameters — the normalization path must not touch them."""
    builtin = Tool(name="$web_search", description="", parameters={})
    converted = _convert_tool(builtin)
    assert converted == {
        "type": "builtin_function",
        "function": {"name": "$web_search"},
    }


def test_convert_tool_passes_through_already_typed_schema() -> None:
    """Tools whose schemas already declare `type` everywhere must round-trip
    unchanged — `ensure_property_types` deep-copies but adds nothing new."""
    tool = Tool(
        name="echo",
        description="Echo input.",
        parameters={
            "type": "object",
            "properties": {"msg": {"type": "string"}},
            "required": ["msg"],
        },
    )
    converted = _convert_tool(tool)
    assert converted["function"].get("parameters") == {
        "type": "object",
        "properties": {"msg": {"type": "string"}},
        "required": ["msg"],
    }

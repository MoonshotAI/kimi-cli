"""Tests for convert_mcp_tool_result: truncation + unsupported content handling."""

from __future__ import annotations

import base64
from collections.abc import Sequence
from unittest.mock import MagicMock

import mcp.types
from kosong.message import ImageURLPart, TextPart
from kosong.tooling import ToolError, ToolOk
from pydantic import AnyUrl

from kimi_cli.soul.toolset import (
    MCP_MAX_OUTPUT_CHARS,
    convert_mcp_tool_result,
    sanitize_mcp_input_schema,
)


def _make_result(
    content: Sequence[mcp.types.ContentBlock],
    *,
    is_error: bool = False,
    structured_content: dict[str, object] | None = None,
) -> MagicMock:
    r = MagicMock()
    r.content = content
    r.is_error = is_error
    r.structured_content = structured_content
    return r


def _text(part: object) -> str:
    """Extract .text from a ContentPart, narrowing for pyright."""
    assert isinstance(part, TextPart)
    return part.text


class TestMCPTruncation:
    def test_small_text_passes_through(self):
        result = _make_result([mcp.types.TextContent(type="text", text="hello")])
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        assert len(out.output) == 1
        assert _text(out.output[0]) == "hello"

    def test_structured_content_is_appended_as_json_text(self):
        result = _make_result(
            [mcp.types.TextContent(type="text", text="Loaded 3 messages")],
            structured_content={
                "items": [{"id": 1, "text": "hello"}, {"id": 2, "text": "world"}],
                "hasMore": True,
            },
        )

        out = convert_mcp_tool_result(result)

        assert isinstance(out, ToolOk)
        assert len(out.output) == 2
        assert _text(out.output[0]) == "Loaded 3 messages"
        structured = _text(out.output[1])
        assert structured.startswith("Structured content:\n")
        assert '"items"' in structured
        assert '"hasMore": true' in structured

    def test_text_truncated_at_budget(self):
        big_text = "x" * (MCP_MAX_OUTPUT_CHARS + 5000)
        result = _make_result([mcp.types.TextContent(type="text", text=big_text)])
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        # Should have truncated text + truncation notice
        assert len(out.output) == 2
        assert len(_text(out.output[0])) == MCP_MAX_OUTPUT_CHARS
        assert "truncated" in _text(out.output[1]).lower()

    def test_multi_part_truncation(self):
        half = MCP_MAX_OUTPUT_CHARS // 2
        part1 = mcp.types.TextContent(type="text", text="a" * (half + 100))
        part2 = mcp.types.TextContent(type="text", text="b" * (half + 100))
        result = _make_result([part1, part2])
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        # part1 passes, part2 gets truncated, plus truncation notice
        total_text = sum(
            len(p.text)
            for p in out.output
            if isinstance(p, TextPart) and "truncated" not in p.text.lower()
        )
        assert total_text <= MCP_MAX_OUTPUT_CHARS

    def test_budget_exhausted_skips_remaining_text(self):
        """When budget is fully consumed, subsequent text parts are skipped."""
        full = mcp.types.TextContent(type="text", text="x" * MCP_MAX_OUTPUT_CHARS)
        extra = mcp.types.TextContent(type="text", text="should be dropped")
        result = _make_result([full, extra])
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        # full text + truncation notice (extra is dropped)
        texts = [p for p in out.output if isinstance(p, TextPart)]
        assert len(texts) == 2
        assert "truncated" in texts[-1].text.lower()

    def test_error_result_preserves_truncation(self):
        big_text = "e" * (MCP_MAX_OUTPUT_CHARS + 1000)
        result = _make_result([mcp.types.TextContent(type="text", text=big_text)], is_error=True)
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolError)
        assert len(out.output) == 2
        assert isinstance(out.output[1], TextPart)
        assert "truncated" in out.output[1].text.lower()

    def test_small_image_counted_against_budget(self):
        """Small images consume budget but fit, so both image and text survive."""
        img = mcp.types.ImageContent(type="image", data="AAAA", mimeType="image/png")
        text = mcp.types.TextContent(type="text", text="hello")
        result = _make_result([img, text])
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        assert len(out.output) == 2
        assert isinstance(out.output[0], ImageURLPart)
        assert _text(out.output[1]) == "hello"


class TestMCPMediaTruncation:
    """Regression tests: oversized non-text MCP payloads must be dropped."""

    def test_oversized_image_dropped(self):
        """A base64 image exceeding the budget should be dropped with truncation notice."""
        # ~150K of base64 data → data URL will be well over MCP_MAX_OUTPUT_CHARS
        big_data = base64.b64encode(b"\x00" * 150_000).decode()
        img = mcp.types.ImageContent(type="image", data=big_data, mimeType="image/png")
        result = _make_result([img])
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        # Image should be dropped; only truncation notice remains
        assert all(isinstance(p, TextPart) for p in out.output)
        assert any("truncated" in _text(p).lower() for p in out.output)

    def test_oversized_blob_resource_dropped(self):
        """An EmbeddedResource with huge blob should be dropped."""
        big_blob = base64.b64encode(b"\xff" * 150_000).decode()
        blob = mcp.types.EmbeddedResource(
            type="resource",
            resource=mcp.types.BlobResourceContents(
                uri=AnyUrl("file:///screenshot.png"),
                mimeType="image/png",
                blob=big_blob,
            ),
        )
        result = _make_result([blob])
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        assert all(isinstance(p, TextPart) for p in out.output)
        assert any("truncated" in _text(p).lower() for p in out.output)

    def test_text_survives_after_oversized_image_dropped(self):
        """When an oversized image is dropped, subsequent text should still be kept."""
        big_data = base64.b64encode(b"\x00" * 150_000).decode()
        img = mcp.types.ImageContent(type="image", data=big_data, mimeType="image/png")
        text = mcp.types.TextContent(type="text", text="caption after screenshot")
        result = _make_result([img, text])
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        texts = [p for p in out.output if isinstance(p, TextPart)]
        assert any("caption" in t.text for t in texts)
        assert any("truncated" in t.text.lower() for t in texts)

    def test_multiple_images_exhaust_budget(self):
        """Multiple medium images that together exceed the budget."""
        # Each image ~ 40K chars of data URL, 3 of them > 100K
        medium_data = base64.b64encode(b"\x00" * 30_000).decode()
        imgs = [
            mcp.types.ImageContent(type="image", data=medium_data, mimeType="image/png")
            for _ in range(4)
        ]
        result = _make_result(imgs)
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        image_parts = [p for p in out.output if isinstance(p, ImageURLPart)]
        # Not all 4 should survive
        assert len(image_parts) < 4
        assert any(isinstance(p, TextPart) and "truncated" in p.text.lower() for p in out.output)


class TestMCPUnsupportedContent:
    def test_unsupported_content_type_becomes_text_error(self):
        """Unknown content type should not crash, but produce an error placeholder."""
        # Create a content block with an unknown type
        unknown = MagicMock(spec=[])  # empty spec = no known attributes
        result = _make_result([unknown])
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        assert len(out.output) == 1
        assert "unsupported" in _text(out.output[0]).lower()

    def test_unsupported_blob_mimetype_becomes_text_error(self):
        """EmbeddedResource with unsupported mime type should not crash."""
        blob = mcp.types.EmbeddedResource(
            type="resource",
            resource=mcp.types.BlobResourceContents(
                uri=AnyUrl("file:///test.bin"),
                mimeType="application/x-custom",
                blob="deadbeef",
            ),
        )
        result = _make_result([blob])
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        assert len(out.output) == 1
        assert "unsupported" in _text(out.output[0]).lower()

    def test_mixed_valid_and_invalid_parts(self):
        """Valid parts should still be converted even when some fail."""
        good = mcp.types.TextContent(type="text", text="valid")
        bad = MagicMock(spec=[])
        result = _make_result([good, bad])
        out = convert_mcp_tool_result(result)
        assert isinstance(out, ToolOk)
        assert len(out.output) == 2
        assert _text(out.output[0]) == "valid"
        assert "unsupported" in _text(out.output[1]).lower()


class TestMCPSchemaSanitizer:
    def test_ref_siblings_are_removed_without_mutating_original(self):
        schema = {
            "type": "object",
            "$defs": {"AssetRef": {"type": "object"}},
            "properties": {
                "assetRef": {
                    "$ref": "#/$defs/AssetRef",
                    "description": "Unity asset reference",
                    "title": "Asset reference",
                }
            },
        }

        sanitized = sanitize_mcp_input_schema(schema)

        assert sanitized["properties"]["assetRef"] == {"$ref": "#/$defs/AssetRef"}
        assert "description" in schema["properties"]["assetRef"]

    def test_nested_ref_siblings_are_sanitized_in_arrays(self):
        schema = {
            "type": "object",
            "properties": {
                "refs": {
                    "type": "array",
                    "items": {
                        "$ref": "#/$defs/AssetRef",
                        "description": "Unity asset reference",
                    },
                }
            },
        }

        sanitized = sanitize_mcp_input_schema(schema)

        assert sanitized["properties"]["refs"]["items"] == {"$ref": "#/$defs/AssetRef"}

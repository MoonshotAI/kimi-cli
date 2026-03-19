"""Tests for Google GenAI schema sanitisation in tool conversion."""

import pytest

pytest.importorskip("google.genai", reason="Optional contrib dependency not installed")

from kosong.contrib.chat_provider.google_genai import _sanitize_schema, tool_to_google_genai
from kosong.tooling import Tool


class TestSanitizeSchema:
    """Unit tests for _sanitize_schema."""

    def test_strips_schema_field(self):
        schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {"x": {"type": "integer"}},
        }
        result = _sanitize_schema(schema)
        assert "$schema" not in result
        assert result["type"] == "object"

    def test_strips_id_field(self):
        schema = {
            "$id": "urn:example:tool",
            "type": "object",
            "properties": {"x": {"type": "integer"}},
        }
        result = _sanitize_schema(schema)
        assert "$id" not in result

    def test_strips_comment_field(self):
        schema = {
            "$comment": "internal note",
            "type": "object",
            "properties": {"x": {"type": "integer"}},
        }
        result = _sanitize_schema(schema)
        assert "$comment" not in result

    def test_strips_multiple_unsupported_fields(self):
        schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "urn:example:tool",
            "$comment": "internal note",
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        }
        result = _sanitize_schema(schema)
        assert "$schema" not in result
        assert "$id" not in result
        assert "$comment" not in result
        assert result["properties"] == {"name": {"type": "string"}}
        assert result["required"] == ["name"]

    def test_resolves_refs_and_removes_defs(self):
        schema = {
            "type": "object",
            "properties": {"user": {"$ref": "#/$defs/User"}},
            "$defs": {"User": {"type": "object", "properties": {"id": {"type": "integer"}}}},
        }
        result = _sanitize_schema(schema)
        assert "$defs" not in result
        assert result["properties"]["user"] == {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
        }

    def test_no_mutation_of_input(self):
        schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {"x": {"type": "integer"}},
        }
        _sanitize_schema(schema)
        assert "$schema" in schema  # original unchanged

    def test_passthrough_clean_schema(self):
        schema = {
            "type": "object",
            "properties": {"a": {"type": "integer"}},
            "required": ["a"],
        }
        result = _sanitize_schema(schema)
        assert result == schema


class TestToolToGoogleGenAi:
    """Integration tests for tool_to_google_genai with schema sanitisation."""

    def test_tool_with_schema_field_is_sanitised(self):
        tool = Tool(
            name="get_weather",
            description="Get weather for a city.",
            parameters={
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        )
        genai_tool = tool_to_google_genai(tool)
        decl = genai_tool.function_declarations[0]
        assert decl.name == "get_weather"
        # The raw JSON schema passed to the API must not contain $schema
        assert "$schema" not in decl.parameters_json_schema

    def test_tool_with_refs_is_resolved(self):
        tool = Tool(
            name="create_user",
            description="Create a user.",
            parameters={
                "type": "object",
                "properties": {"user": {"$ref": "#/$defs/User"}},
                "$defs": {
                    "User": {"type": "object", "properties": {"name": {"type": "string"}}}
                },
            },
        )
        genai_tool = tool_to_google_genai(tool)
        params = genai_tool.function_declarations[0].parameters_json_schema
        assert "$defs" not in params
        assert params["properties"]["user"]["type"] == "object"

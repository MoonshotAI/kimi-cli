"""Test that tool schemas are patched correctly for k2-thinking models."""
import json

import pytest

from kimi_cli.utils.schema import inline_json_schema_refs


def test_inline_json_schema_refs_simple():
    """Test inlining simple $ref references."""
    schema = {
        "$defs": {
            "Item": {"type": "object", "properties": {"name": {"type": "string"}}}
        },
        "type": "object",
        "properties": {
            "items": {"type": "array", "items": {"$ref": "#/$defs/Item"}}
        }
    }
    result = inline_json_schema_refs(schema)
    
    assert "$defs" not in result
    assert "$ref" not in json.dumps(result)
    assert result["properties"]["items"]["items"]["type"] == "object"
    assert result["properties"]["items"]["items"]["properties"]["name"]["type"] == "string"


def test_inline_json_schema_refs_nested():
    """Test inlining nested $ref references."""
    schema = {
        "$defs": {
            "Address": {
                "type": "object",
                "properties": {
                    "street": {"type": "string"},
                    "city": {"type": "string"}
                }
            },
            "Person": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "address": {"$ref": "#/$defs/Address"}
                }
            }
        },
        "type": "object",
        "properties": {
            "people": {"type": "array", "items": {"$ref": "#/$defs/Person"}}
        }
    }
    result = inline_json_schema_refs(schema)
    
    assert "$defs" not in result
    assert "$ref" not in json.dumps(result)
    person = result["properties"]["people"]["items"]
    assert person["properties"]["name"]["type"] == "string"
    assert person["properties"]["address"]["type"] == "object"
    assert person["properties"]["address"]["properties"]["street"]["type"] == "string"


def test_inline_json_schema_refs_no_refs():
    """Test that schemas without $ref work correctly."""
    schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "age": {"type": "number"}
        }
    }
    result = inline_json_schema_refs(schema)
    assert result == schema

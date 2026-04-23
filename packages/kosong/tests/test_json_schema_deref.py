from __future__ import annotations

from typing import Literal

from inline_snapshot import snapshot
from pydantic import BaseModel, Field

from kosong.utils.jsonschema import deref_json_schema, ensure_property_types
from kosong.utils.typing import JsonType

JsonSchema = dict[str, JsonType]


def test_no_ref():
    class Params(BaseModel):
        id: str = Field(description="The ID of the action.")
        action: str = Field(description="The action to be performed.")

    resolved = deref_json_schema(Params.model_json_schema())
    assert resolved == snapshot(
        {
            "properties": {
                "id": {"description": "The ID of the action.", "title": "Id", "type": "string"},
                "action": {
                    "description": "The action to be performed.",
                    "title": "Action",
                    "type": "string",
                },
            },
            "required": ["id", "action"],
            "title": "Params",
            "type": "object",
        }
    )


def test_simple_ref():
    class Todo(BaseModel):
        title: str = Field(description="The title of the todo item.")
        status: Literal["pending", "completed"] = Field(description="The status of the todo item.")

    class Params(BaseModel):
        todos: list[Todo] = Field(description="A list of todo items.")

    resolved = deref_json_schema(Params.model_json_schema())
    assert resolved == snapshot(
        {
            "properties": {
                "todos": {
                    "description": "A list of todo items.",
                    "items": {
                        "properties": {
                            "title": {
                                "description": "The title of the todo item.",
                                "title": "Title",
                                "type": "string",
                            },
                            "status": {
                                "description": "The status of the todo item.",
                                "enum": ["pending", "completed"],
                                "title": "Status",
                                "type": "string",
                            },
                        },
                        "required": ["title", "status"],
                        "title": "Todo",
                        "type": "object",
                    },
                    "title": "Todos",
                    "type": "array",
                }
            },
            "required": ["todos"],
            "title": "Params",
            "type": "object",
        }
    )


def test_ensure_property_types_fills_missing_type_on_enum():
    """Regression for Moonshot 400: an MCP tool property with only `enum` and
    no `type` (as emitted by some JetBrains MCP tools, e.g. `truncateMode`)
    must have `type` filled in so the schema passes Moonshot validation."""
    schema: JsonSchema = {
        "type": "object",
        "properties": {
            "truncateMode": {
                "description": "How to truncate long outputs.",
                "enum": ["smart", "full", "none"],
            }
        },
    }
    assert ensure_property_types(schema) == snapshot(
        {
            "type": "object",
            "properties": {
                "truncateMode": {
                    "description": "How to truncate long outputs.",
                    "enum": ["smart", "full", "none"],
                    "type": "string",
                }
            },
        }
    )


def test_ensure_property_types_does_not_mutate_input():
    schema: JsonSchema = {
        "type": "object",
        "properties": {"x": {"enum": ["a", "b"]}},
    }
    ensure_property_types(schema)
    assert schema == {
        "type": "object",
        "properties": {"x": {"enum": ["a", "b"]}},
    }


def test_ensure_property_types_infers_from_enum_values():
    schema: JsonSchema = {
        "type": "object",
        "properties": {
            "as_string": {"enum": ["a", "b"]},
            "as_integer": {"enum": [1, 2, 3]},
            # integer ⊂ number, so {int, float} collapses to "number".
            "int_and_float_as_number": {"enum": [1.0, 2]},
            "as_boolean": {"enum": [True, False]},
            "as_null": {"enum": [None]},
            # bool is NOT a subtype of int in JSON Schema, so {bool, int}
            # must fall back to "string" rather than misclassify as "integer"
            # (which would silently exclude the boolean values).
            "bool_and_int_fallback": {"enum": [True, 1]},
            "string_and_int_fallback": {"enum": ["a", 1]},
        },
    }
    resolved = ensure_property_types(schema)
    assert resolved == snapshot(
        {
            "type": "object",
            "properties": {
                "as_string": {"enum": ["a", "b"], "type": "string"},
                "as_integer": {"enum": [1, 2, 3], "type": "integer"},
                "int_and_float_as_number": {"enum": [1.0, 2], "type": "number"},
                "as_boolean": {"enum": [True, False], "type": "boolean"},
                "as_null": {"enum": [None], "type": "null"},
                "bool_and_int_fallback": {"enum": [True, 1], "type": "string"},
                "string_and_int_fallback": {"enum": ["a", 1], "type": "string"},
            },
        }
    )


def test_ensure_property_types_handles_const():
    schema: JsonSchema = {
        "type": "object",
        "properties": {"kind": {"const": "event"}},
    }
    assert ensure_property_types(schema) == snapshot(
        {
            "type": "object",
            "properties": {"kind": {"const": "event", "type": "string"}},
        }
    )


def test_ensure_property_types_defaults_to_string_when_no_hint():
    schema: JsonSchema = {
        "type": "object",
        "properties": {"opaque": {"description": "Some value."}},
    }
    assert ensure_property_types(schema) == snapshot(
        {
            "type": "object",
            "properties": {"opaque": {"description": "Some value.", "type": "string"}},
        }
    )


def test_ensure_property_types_leaves_combinators_alone():
    """Properties using anyOf/oneOf/allOf/$ref legitimately declare their shape
    without a top-level `type` — we must not overwrite that."""
    schema: JsonSchema = {
        "type": "object",
        "properties": {
            "either": {
                "anyOf": [
                    {"type": "string"},
                    {"enum": [1, 2]},  # nested branch still gets its type filled
                ]
            },
            "ref_prop": {"$ref": "#/$defs/Something"},
        },
    }
    assert ensure_property_types(schema) == snapshot(
        {
            "type": "object",
            "properties": {
                "either": {
                    "anyOf": [
                        {"type": "string"},
                        {"enum": [1, 2], "type": "integer"},
                    ]
                },
                "ref_prop": {"$ref": "#/$defs/Something"},
            },
        }
    )


def test_ensure_property_types_recurses_into_nested_objects_and_arrays():
    schema: JsonSchema = {
        "type": "object",
        "properties": {
            "nested": {
                "type": "object",
                "properties": {
                    "choice": {"enum": ["a", "b"]},
                },
            },
            "items_list": {
                "type": "array",
                "items": {"enum": [1, 2, 3]},
            },
            "free_map": {
                "type": "object",
                "additionalProperties": {"enum": ["x", "y"]},
            },
        },
    }
    assert ensure_property_types(schema) == snapshot(
        {
            "type": "object",
            "properties": {
                "nested": {
                    "type": "object",
                    "properties": {
                        "choice": {"enum": ["a", "b"], "type": "string"},
                    },
                },
                "items_list": {
                    "type": "array",
                    "items": {"enum": [1, 2, 3], "type": "integer"},
                },
                "free_map": {
                    "type": "object",
                    "additionalProperties": {"enum": ["x", "y"], "type": "string"},
                },
            },
        }
    )


def test_nested_ref():
    class Address(BaseModel):
        street: str = Field(description="The street address.")
        city: str = Field(description="The city.")
        zip_code: str = Field(description="The ZIP code.")

    class User(BaseModel):
        name: str = Field(description="The name of the user.")
        email: str = Field(description="The email of the user.")
        address: Address = Field(description="The address of the user.")

    class Params(BaseModel):
        users: list[User] = Field(description="A list of users.")

    resolved = deref_json_schema(Params.model_json_schema())
    assert resolved == snapshot(
        {
            "properties": {
                "users": {
                    "description": "A list of users.",
                    "items": {
                        "properties": {
                            "name": {
                                "description": "The name of the user.",
                                "title": "Name",
                                "type": "string",
                            },
                            "email": {
                                "description": "The email of the user.",
                                "title": "Email",
                                "type": "string",
                            },
                            "address": {
                                "description": "The address of the user.",
                                "properties": {
                                    "street": {
                                        "description": "The street address.",
                                        "title": "Street",
                                        "type": "string",
                                    },
                                    "city": {
                                        "description": "The city.",
                                        "title": "City",
                                        "type": "string",
                                    },
                                    "zip_code": {
                                        "description": "The ZIP code.",
                                        "title": "Zip Code",
                                        "type": "string",
                                    },
                                },
                                "required": ["street", "city", "zip_code"],
                                "title": "Address",
                                "type": "object",
                            },
                        },
                        "required": ["name", "email", "address"],
                        "title": "User",
                        "type": "object",
                    },
                    "title": "Users",
                    "type": "array",
                }
            },
            "required": ["users"],
            "title": "Params",
            "type": "object",
        }
    )

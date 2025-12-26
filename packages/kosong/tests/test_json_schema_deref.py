from __future__ import annotations

from typing import Literal

from inline_snapshot import snapshot
from pydantic import BaseModel, Field

from kosong.utils.jsonschema import deref_json_schema
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

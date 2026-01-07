from __future__ import annotations

from abc import ABC
from typing import Any, ClassVar, Literal, cast

from pydantic import BaseModel, GetCoreSchemaHandler
from pydantic_core import core_schema

from kimi_types import JsonType


class DisplayBlock(BaseModel, ABC):
    """
    A block of content to be displayed to the user.

    Similar to ContentPart, but scoped to tool return display payloads (user-facing UI).
    ContentPart is for model-facing message content; DisplayBlock is for tool/UI extensions.
    """

    __display_block_registry: ClassVar[dict[str, type[DisplayBlock]]] = {}

    type: str
    ...  # to be added by subclasses

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)

        invalid_subclass_error_msg = (
            f"DisplayBlock subclass {cls.__name__} must have a `type` field of type `str`"
        )

        type_value = getattr(cls, "type", None)
        if type_value is None or not isinstance(type_value, str):
            raise ValueError(invalid_subclass_error_msg)

        cls.__display_block_registry[type_value] = cls

    @classmethod
    def __get_pydantic_core_schema__(
        cls, source_type: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        # If we're dealing with the base DisplayBlock class, use custom validation
        if cls.__name__ == "DisplayBlock":

            def validate_display_block(value: Any) -> Any:
                # if it's already an instance of a DisplayBlock subclass, return it
                if hasattr(value, "__class__") and issubclass(value.__class__, cls):
                    return value

                # if it's a dict with a type field, dispatch to the appropriate subclass
                if isinstance(value, dict) and "type" in value:
                    type_value: Any | None = cast(dict[str, Any], value).get("type")
                    if not isinstance(type_value, str):
                        raise ValueError(f"Cannot validate {value} as DisplayBlock")
                    target_class = cls.__display_block_registry.get(type_value)
                    if target_class is None:
                        data = {k: v for k, v in cast(dict[str, Any], value).items() if k != "type"}
                        return UnknownDisplayBlock.model_validate(
                            {"type": type_value, "data": data}
                        )
                    return target_class.model_validate(value)

                raise ValueError(f"Cannot validate {value} as DisplayBlock")

            return core_schema.no_info_plain_validator_function(validate_display_block)

        # for subclasses, use the default schema
        return handler(source_type)


class UnknownDisplayBlock(DisplayBlock):
    """Fallback display block for unknown types."""

    type: str = "unknown"
    data: JsonType


class BriefDisplayBlock(DisplayBlock):
    """A brief display block with plain string content."""

    type: str = "brief"
    text: str


class DiffDisplayBlock(DisplayBlock):
    """Display block describing a file diff."""

    type: str = "diff"
    path: str
    old_text: str
    new_text: str


class TodoDisplayItem(BaseModel):
    title: str
    status: Literal["pending", "in_progress", "done"]


class TodoDisplayBlock(DisplayBlock):
    """Display block describing a todo list update."""

    type: str = "todo"
    items: list[TodoDisplayItem]


__all__ = [
    "DisplayBlock",
    "UnknownDisplayBlock",
    "BriefDisplayBlock",
    "DiffDisplayBlock",
    "TodoDisplayItem",
    "TodoDisplayBlock",
]

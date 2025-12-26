from abc import ABC
from typing import Any, ClassVar, Literal, cast, override

from pydantic import BaseModel, GetCoreSchemaHandler, field_serializer, field_validator
from pydantic_core import core_schema

from kosong.utils.typing import JsonType


class MergeableMixin:
    def merge_in_place(self, other: Any) -> bool:
        """Merge the other part into the current part. Return True if the merge is successful."""
        return False


class ContentPart(BaseModel, ABC, MergeableMixin):
    """A part of a message content."""

    __content_part_registry: ClassVar[dict[str, type["ContentPart"]]] = {}

    type: str
    ...  # to be added by subclasses

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)

        invalid_subclass_error_msg = (
            f"ContentPart subclass {cls.__name__} must have a `type` field of type `str`"
        )

        type_value = getattr(cls, "type", None)
        if type_value is None or not isinstance(type_value, str):
            raise ValueError(invalid_subclass_error_msg)

        cls.__content_part_registry[type_value] = cls

    @classmethod
    def __get_pydantic_core_schema__(
        cls, source_type: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        # If we're dealing with the base ContentPart class, use custom validation
        if cls.__name__ == "ContentPart":

            def validate_content_part(value: Any) -> Any:
                # if it's already an instance of a ContentPart subclass, return it
                if hasattr(value, "__class__") and issubclass(value.__class__, cls):
                    return value

                # if it's a dict with a type field, dispatch to the appropriate subclass
                if isinstance(value, dict) and "type" in value:
                    type_value: Any | None = cast(dict[str, Any], value).get("type")
                    if not isinstance(type_value, str):
                        raise ValueError(f"Cannot validate {value} as ContentPart")
                    target_class = cls.__content_part_registry[type_value]
                    return target_class.model_validate(value)

                raise ValueError(f"Cannot validate {value} as ContentPart")

            return core_schema.no_info_plain_validator_function(validate_content_part)

        # for subclasses, use the default schema
        return handler(source_type)


class TextPart(ContentPart):
    """
    >>> TextPart(text="Hello, world!").model_dump()
    {'type': 'text', 'text': 'Hello, world!'}
    """

    type: str = "text"
    text: str

    @override
    def merge_in_place(self, other: Any) -> bool:
        if not isinstance(other, TextPart):
            return False
        self.text += other.text
        return True


class ThinkPart(ContentPart):
    """
    >>> ThinkPart(think="I think I need to think about this.").model_dump()
    {'type': 'think', 'think': 'I think I need to think about this.', 'encrypted': None}
    """

    type: str = "think"
    think: str
    encrypted: str | None = None
    """Encrypted thinking content, or signature."""

    @override
    def merge_in_place(self, other: Any) -> bool:
        if not isinstance(other, ThinkPart):
            return False
        if self.encrypted:
            return False
        self.think += other.think
        if other.encrypted:
            self.encrypted = other.encrypted
        return True


class ImageURLPart(ContentPart):
    """
    >>> ImageURLPart(
    ...     image_url=ImageURLPart.ImageURL(url="https://example.com/image.png")
    ... ).model_dump()
    {'type': 'image_url', 'image_url': {'url': 'https://example.com/image.png', 'id': None}}
    """

    class ImageURL(BaseModel):
        """Image URL payload."""

        url: str
        """The URL of the image, can be data URI scheme like `data:image/png;base64,...`."""
        id: str | None = None
        """The ID of the image, to allow LLMs to distinguish different images."""

    type: str = "image_url"
    image_url: ImageURL


class AudioURLPart(ContentPart):
    """
    >>> AudioURLPart(
    ...     audio_url=AudioURLPart.AudioURL(url="https://example.com/audio.mp3")
    ... ).model_dump()
    {'type': 'audio_url', 'audio_url': {'url': 'https://example.com/audio.mp3', 'id': None}}
    """

    class AudioURL(BaseModel):
        """Audio URL payload."""

        url: str
        """The URL of the audio, can be data URI scheme like `data:audio/aac;base64,...`."""
        id: str | None = None
        """The ID of the audio, to allow LLMs to distinguish different audios."""

    type: str = "audio_url"
    audio_url: AudioURL


class ToolCall(BaseModel, MergeableMixin):
    """
    A tool call requested by the assistant.

    >>> ToolCall(
    ...     id="123",
    ...     function=ToolCall.FunctionBody(name="function", arguments="{}"),
    ... ).model_dump(exclude_none=True)
    {'type': 'function', 'id': '123', 'function': {'name': 'function', 'arguments': '{}'}}
    """

    class FunctionBody(BaseModel):
        """Tool call function body."""

        name: str
        """The name of the tool to be called."""
        arguments: str | None
        """Arguments of the tool call in JSON string format."""

    type: Literal["function"] = "function"

    id: str
    """The ID of the tool call."""
    function: FunctionBody
    """The function body of the tool call."""
    extras: dict[str, JsonType] | None = None
    """Extra information about the tool call."""

    @override
    def merge_in_place(self, other: Any) -> bool:
        if not isinstance(other, ToolCallPart):
            return False
        if self.function.arguments is None:
            self.function.arguments = other.arguments_part
        else:
            self.function.arguments += other.arguments_part or ""
        return True


class ToolCallPart(BaseModel, MergeableMixin):
    """A part of the tool call."""

    arguments_part: str | None = None
    """A part of the arguments of the tool call."""

    @override
    def merge_in_place(self, other: Any) -> bool:
        if not isinstance(other, ToolCallPart):
            return False
        if self.arguments_part is None:
            self.arguments_part = other.arguments_part
        else:
            self.arguments_part += other.arguments_part or ""
        return True


type Role = Literal[
    # for OpenAI API, this should be converted to `developer`
    # OpenAI & Kimi support system messages in the middle of the conversation.
    # Anthropic only support system messages at the beginning https://docs.claude.com/en/api/messages#body-messages
    # In this case, we map `system` message to a `user` message wrapped in `<system></system>` tags.
    "system",
    "user",
    "assistant",
    "tool",
]
"""The role of a message sender."""


class Message(BaseModel):
    """A message in a conversation."""

    role: Role
    """The role of the message sender."""

    name: str | None = None

    content: list[ContentPart]
    """
    The content of the message.
    Empty list `[]` will be interpreted as no content.
    """

    tool_calls: list[ToolCall] | None = None
    """Tool calls requested by the assistant in this message."""

    tool_call_id: str | None = None
    """The ID of the tool call if this message is a tool response."""

    partial: bool | None = None

    @field_serializer("content")
    def _serialize_content(self, content: list[ContentPart]) -> str | list[dict[str, Any]] | None:
        if len(content) == 1 and isinstance(content[0], TextPart):
            return content[0].text
        return [part.model_dump() for part in content]

    @field_validator("content", mode="before")
    @classmethod
    def _coerce_none_content(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, str):
            return [TextPart(text=value)]
        return value

    def __init__(
        self,
        *,
        role: Role,
        content: list[ContentPart] | ContentPart | str,
        tool_calls: list[ToolCall] | None = None,
        tool_call_id: str | None = None,
        **data: Any,
    ) -> None:
        if isinstance(content, str):
            content = [TextPart(text=content)]
        elif isinstance(content, ContentPart):
            content = [content]
        super().__init__(
            role=role,
            content=content,
            tool_calls=tool_calls,
            tool_call_id=tool_call_id,
            **data,
        )

    def extract_text(self, sep: str = "") -> str:
        """Extract and concatenate all text parts in the message content."""
        return sep.join(part.text for part in self.content if isinstance(part, TextPart))

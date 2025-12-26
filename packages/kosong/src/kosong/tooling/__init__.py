from abc import ABC, abstractmethod
from asyncio import Future
from typing import Any, ClassVar, Protocol, Self, cast, override, runtime_checkable

import jsonschema
import pydantic
from pydantic import BaseModel, GetCoreSchemaHandler, model_validator
from pydantic.json_schema import GenerateJsonSchema
from pydantic_core import core_schema

from kosong.message import ContentPart, ToolCall
from kosong.utils.jsonschema import deref_json_schema
from kosong.utils.typing import JsonType

type ParametersType = dict[str, Any]


class Tool(BaseModel):
    """The definition of a tool that can be recognized by the model."""

    name: str
    """The name of the tool."""

    description: str
    """The description of the tool."""

    parameters: ParametersType
    """The parameters of the tool, in JSON Schema format."""

    @model_validator(mode="after")
    def _validate_parameters(self) -> Self:
        jsonschema.validate(self.parameters, jsonschema.Draft202012Validator.META_SCHEMA)
        return self


class DisplayBlock(BaseModel, ABC):
    """
    A block of content to be displayed to the user.

    Similar to ContentPart, but scoped to tool return display payloads (user-facing UI).
    ContentPart is for model-facing message content; DisplayBlock is for tool/UI extensions.
    """

    __display_block_registry: ClassVar[dict[str, type["DisplayBlock"]]] = {}

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


class ToolReturnValue(BaseModel):
    """The return type of a callable tool."""

    is_error: bool
    """Whether the tool call resulted in an error."""

    # For model
    output: str | list[ContentPart]
    """The output content returned by the tool."""
    message: str
    """An explanatory message to be given to the model."""

    # For user
    display: list[DisplayBlock]
    """The content blocks to be displayed to the user."""

    # For debugging/testing
    extras: dict[str, JsonType] | None = None

    @property
    def brief(self) -> str:
        """Get the brief display block data, if any."""
        for block in self.display:
            if isinstance(block, BriefDisplayBlock):
                return block.text
        return ""


class ToolOk(ToolReturnValue):
    """Subclass of `ToolReturnValue` representing a successful tool call."""

    def __init__(
        self,
        *,
        output: str | ContentPart | list[ContentPart],
        message: str = "",
        brief: str = "",
    ) -> None:
        super().__init__(
            is_error=False,
            output=([output] if isinstance(output, ContentPart) else output),
            message=message,
            display=[BriefDisplayBlock(text=brief)] if brief else [],
        )


class ToolError(ToolReturnValue):
    """Subclass of `ToolReturnValue` representing a failed tool call."""

    def __init__(
        self, *, message: str, brief: str, output: str | ContentPart | list[ContentPart] = ""
    ):
        super().__init__(
            is_error=True,
            output=([output] if isinstance(output, ContentPart) else output),
            message=message,
            display=[BriefDisplayBlock(text=brief)] if brief else [],
        )


class CallableTool(Tool, ABC):
    """
    The abstract base class of tools that can be called as callables.

    The tool will be called with the arguments provided in the `ToolCall`.
    If the arguments are given as a JSON array, it will be unpacked into positional arguments.
    If the arguments are given as a JSON object, it will be unpacked into keyword arguments.
    Otherwise, the arguments will be passed as a single argument.
    """

    @property
    def base(self) -> Tool:
        """The base tool definition."""
        return self

    async def call(self, arguments: JsonType) -> ToolReturnValue:
        from kosong.tooling.error import ToolValidateError

        try:
            jsonschema.validate(arguments, self.parameters)
        except jsonschema.ValidationError as e:
            return ToolValidateError(str(e))

        if isinstance(arguments, list):
            ret = await self.__call__(*arguments)
        elif isinstance(arguments, dict):
            ret = await self.__call__(**arguments)
        else:
            ret = await self.__call__(arguments)
        if not isinstance(ret, ToolReturnValue):  # pyright: ignore[reportUnnecessaryIsInstance]
            # let's do not trust the return type of the tool
            ret = ToolError(
                message=f"Invalid return type: {type(ret)}",
                brief="Invalid return type",
            )
        return ret

    @abstractmethod
    async def __call__(self, *args: Any, **kwargs: Any) -> ToolReturnValue:
        """
        @public

        The implementation of the callable tool.
        """
        ...


class _GenerateJsonSchemaNoTitles(GenerateJsonSchema):
    """Custom JSON schema generator that omits titles."""

    @override
    def field_title_should_be_set(self, schema) -> bool:  # pyright: ignore[reportMissingParameterType]
        return False

    @override
    def _update_class_schema(self, json_schema, cls, config) -> None:  # pyright: ignore[reportMissingParameterType]
        super()._update_class_schema(json_schema, cls, config)
        json_schema.pop("title", None)


class CallableTool2[Params: BaseModel](ABC):
    """
    The abstract base class of tools that can be called as callables, with typed parameters.

    The tool will be called with the arguments provided in the `ToolCall`.
    The arguments must be a JSON object, and will be validated by Pydantic to the `Params` type.
    """

    name: str
    """The name of the tool."""
    description: str
    """The description of the tool."""
    params: type[Params]
    """The Pydantic model type of the tool parameters."""

    def __init__(
        self,
        name: str | None = None,
        description: str | None = None,
        params: type[Params] | None = None,
    ) -> None:
        cls = self.__class__

        self.name = name or getattr(cls, "name", "")
        if not self.name:
            raise ValueError(
                "Tool name must be provided either as class variable or constructor argument"
            )
        if not isinstance(self.name, str):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise ValueError("Tool name must be a string")

        self.description = description or getattr(cls, "description", "")
        if not self.description:
            raise ValueError(
                "Tool description must be provided either as class variable or constructor argument"
            )
        if not isinstance(self.description, str):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise ValueError("Tool description must be a string")

        self.params = params or getattr(cls, "params", None)  # type: ignore
        if not self.params:
            raise ValueError(
                "Tool param must be provided either as class variable or constructor argument"
            )
        if not isinstance(self.params, type) or not issubclass(self.params, BaseModel):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise ValueError("Tool params must be a subclass of pydantic.BaseModel")

        self._base = Tool(
            name=self.name,
            description=self.description,
            parameters=deref_json_schema(
                self.params.model_json_schema(schema_generator=_GenerateJsonSchemaNoTitles)
            ),
        )

    @property
    def base(self) -> Tool:
        """The base tool definition."""
        return self._base

    async def call(self, arguments: JsonType) -> ToolReturnValue:
        from kosong.tooling.error import ToolValidateError

        try:
            params = self.params.model_validate(arguments)
        except pydantic.ValidationError as e:
            return ToolValidateError(str(e))

        ret = await self.__call__(params)
        if not isinstance(ret, ToolReturnValue):  # pyright: ignore[reportUnnecessaryIsInstance]
            # let's do not trust the return type of the tool
            ret = ToolError(
                message=f"Invalid return type: {type(ret)}",
                brief="Invalid return type",
            )
        return ret

    @abstractmethod
    async def __call__(self, params: Params) -> ToolReturnValue:
        """
        @public

        The implementation of the callable tool.
        """
        ...


class ToolResult(BaseModel):
    """The result of a tool call."""

    tool_call_id: str
    """The ID of the tool call."""
    return_value: ToolReturnValue
    """The actual return value of the tool call."""


ToolResultFuture = Future[ToolResult]
type HandleResult = ToolResultFuture | ToolResult


@runtime_checkable
class Toolset(Protocol):
    """
    The interface of toolsets that can register tools and handle tool calls.
    """

    @property
    def tools(self) -> list[Tool]:
        """The list of tool definitions registered in this toolset."""
        ...

    def handle(self, tool_call: ToolCall) -> HandleResult:
        """
        Handle a tool call.
        The result of the tool call, or the async future of the result, should be returned.
        The result should be a `ToolReturnValue`.

        This method MUST NOT do any blocking operations because it will be called during
        consuming the chat response stream.
        This method MUST NOT raise any exception except for `asyncio.CancelledError`. Any other
        error should be returned as a `ToolReturnValue` with `is_error=True`.
        """
        ...

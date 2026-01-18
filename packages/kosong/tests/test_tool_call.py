import asyncio
import json
from typing import override

from inline_snapshot import snapshot
from pydantic import BaseModel, Field

from kosong.message import ToolCall
from kosong.tooling import (
    BriefDisplayBlock,
    CallableTool,
    CallableTool2,
    ParametersType,
    ToolError,
    ToolOk,
    ToolResult,
    ToolResultFuture,
    ToolReturnValue,
)
from kosong.tooling.error import (
    ToolNotFoundError,
    ToolParseError,
    ToolRuntimeError,
    ToolValidateError,
)
from kosong.tooling.simple import SimpleToolset


def test_callable_tool_int_argument():
    class TestTool(CallableTool):
        name: str = "test"
        description: str = "This is a test tool"
        parameters: ParametersType = {
            "type": "integer",
        }

        @override
        async def __call__(self, test: int) -> ToolReturnValue:
            return ToolOk(output=f"Test tool called with {test}")

    tool = TestTool()
    assert asyncio.run(tool.call(1)) == ToolOk(output="Test tool called with 1")


def test_callable_tool_list_argument():
    class TestTool(CallableTool):
        name: str = "test"
        description: str = "This is a test tool"
        parameters: ParametersType = {
            "type": "array",
            "items": {
                "type": "string",
            },
        }

        @override
        async def __call__(self, a: str, b: str) -> ToolReturnValue:
            return ToolOk(output="Test tool called with a and b")

    tool = TestTool()
    assert asyncio.run(tool.call(["a", "b"])) == ToolOk(output="Test tool called with a and b")


def test_callable_tool_dict_argument():
    class TestTool(CallableTool):
        name: str = "test"
        description: str = "This is a test tool"
        parameters: ParametersType = {
            "type": "object",
            "properties": {
                "a": {"type": "string"},
                "b": {"type": "integer"},
            },
        }

        @override
        async def __call__(self, a: str, b: int) -> ToolReturnValue:
            return ToolOk(output=f"Test tool called with {a} and {b}")

    tool = TestTool()
    assert asyncio.run(tool.call({"a": "a", "b": 1})) == ToolOk(
        output="Test tool called with a and 1"
    )


def test_simple_toolset():
    class PlusTool(CallableTool):
        name: str = "plus"
        description: str = "This is a plus tool"
        parameters: ParametersType = {
            "type": "object",
            "properties": {
                "a": {"type": "integer"},
                "b": {"type": "integer"},
            },
            "required": ["a", "b"],
        }

        @override
        async def __call__(self, a: int, b: int) -> ToolReturnValue:
            return ToolOk(output=str(a + b))

    class CompareTool(CallableTool):
        name: str = "compare"
        description: str = "This is a compare tool"
        parameters: ParametersType = {
            "type": "object",
            "properties": {
                "a": {"type": "integer"},
                "b": {"type": "integer"},
            },
            "required": ["a", "b"],
        }

        @override
        async def __call__(self, a: int, b: int) -> ToolReturnValue:
            return ToolOk(output="greater" if a > b else "less" if a < b else "equal")

    class RaiseTool(CallableTool):
        name: str = "raise"
        description: str = "This is a raise tool"
        parameters: ParametersType = {
            "type": "object",
            "properties": {},
        }

        @override
        async def __call__(self) -> ToolReturnValue:
            raise Exception("test exception")

    class ErrorTool(CallableTool):
        name: str = "error"
        description: str = "This is a error tool"
        parameters: ParametersType = {
            "type": "object",
            "properties": {},
        }

        @override
        async def __call__(self) -> ToolReturnValue:
            return ToolError(message="test error", brief="Error")

    class InvalidReturnTypeTool(CallableTool):
        name: str = "invalid_return_type"
        description: str = "This is a invalid return type tool"
        parameters: ParametersType = {
            "type": "object",
            "properties": {},
        }

        @override
        async def __call__(self) -> str:  # type: ignore[reportIncompatibleMethodOverride]
            return "invalid return type"

    toolset = SimpleToolset([PlusTool()])
    toolset += CompareTool()
    toolset += RaiseTool()
    toolset.add(ErrorTool())
    assert toolset.tools[0].name == "plus"
    assert toolset.tools[1].name == "compare"
    assert toolset.tools[2].name == "raise"
    assert toolset.tools[3].name == "error"

    try:
        toolset += InvalidReturnTypeTool()
    except TypeError as e:
        assert str(e) == (
            "Expected tool `invalid_return_type` to return `ToolReturnValue`, "
            "but got `<class 'str'>`"
        )
    else:
        raise AssertionError("Expected TypeError")

    tool_calls = [
        ToolCall(
            id="1",
            function=ToolCall.FunctionBody(
                name="plus",
                arguments=json.dumps({"a": 1, "b": 2}),
            ),
        ),
        ToolCall(
            id="2",
            function=ToolCall.FunctionBody(
                name="compare",
                arguments='{"a": 1, b: 2}',
            ),
        ),
        ToolCall(
            id="3",
            function=ToolCall.FunctionBody(
                name="plus",
                arguments='{"a": 1}',
            ),
        ),
        ToolCall(
            id="4",
            function=ToolCall.FunctionBody(
                name="raise",
                arguments=None,
            ),
        ),
        ToolCall(
            id="5",
            function=ToolCall.FunctionBody(
                name="not_found",
                arguments=None,
            ),
        ),
        ToolCall(
            id="6",
            function=ToolCall.FunctionBody(
                name="error",
                arguments=None,
            ),
        ),
    ]

    async def run() -> list[ToolResult]:
        futures: list[ToolResultFuture] = []
        for tool_call in tool_calls:
            result = toolset.handle(tool_call)
            if isinstance(result, ToolResult):
                future = ToolResultFuture()
                future.set_result(result)
                futures.append(future)
            else:
                futures.append(result)
        return await asyncio.gather(*futures)

    results = asyncio.run(run())
    assert results[0].tool_call_id == "1"
    assert results[0].return_value == ToolOk(output="3")
    assert isinstance(results[1].return_value, ToolParseError)
    assert isinstance(results[2].return_value, ToolValidateError)
    assert isinstance(results[3].return_value, ToolRuntimeError)
    assert isinstance(results[4].return_value, ToolNotFoundError)
    assert isinstance(results[5].return_value, ToolError)
    assert results[5].return_value.message == "test error"
    assert results[5].return_value.display == snapshot([BriefDisplayBlock(text="Error")])


def test_callable_tool_2():
    class TestParams(BaseModel):
        a: int = Field(description="The first argument")
        b: int = Field(default=0, description="The second argument")
        c: str = Field(default="", alias="-c", description="The third argument")

    class TestTool(CallableTool2[TestParams]):
        name: str = "test"
        description: str = "This is a test tool"
        params: type[TestParams] = TestParams

        @override
        async def __call__(self, params: TestParams) -> ToolReturnValue:
            return ToolOk(output=f"Test tool called with {params.a} and {params.b}")

    tool = TestTool()
    assert tool.base.name == "test"
    assert tool.base.description == "This is a test tool"
    assert tool.base.parameters == {
        "type": "object",
        "properties": {
            "a": {"type": "integer", "description": "The first argument"},
            "b": {"type": "integer", "description": "The second argument", "default": 0},
            "-c": {"type": "string", "description": "The third argument", "default": ""},
        },
        "required": ["a"],
    }

    assert asyncio.run(tool.call({"a": 1, "b": 2})) == ToolOk(
        output="Test tool called with 1 and 2"
    )
    assert asyncio.run(tool.call({"a": 1})) == ToolOk(output="Test tool called with 1 and 0")
    assert isinstance(asyncio.run(tool.call({"b": 2})), ToolValidateError)


def test_simple_toolset_sub():
    class TestParams(BaseModel):
        pass

    class TestTool(CallableTool2[TestParams]):
        name: str = "test"
        description: str = "This is a test tool"
        params: type[TestParams] = TestParams

        @override
        async def __call__(self, params: TestParams) -> ToolReturnValue:
            return ToolOk(output="Test tool called")

    toolset = SimpleToolset([TestTool()])
    assert len(toolset.tools) == 1
    toolset.remove(TestTool.name)
    assert len(toolset.tools) == 0

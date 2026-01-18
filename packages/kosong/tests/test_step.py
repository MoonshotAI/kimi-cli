import asyncio
from typing import override

from kosong import step
from kosong.chat_provider import StreamedMessagePart
from kosong.chat_provider.mock import MockChatProvider
from kosong.message import TextPart, ToolCall
from kosong.tooling import CallableTool, ParametersType, ToolOk, ToolResult, ToolReturnValue
from kosong.tooling.simple import SimpleToolset


def test_step():
    class PlusTool(CallableTool):
        name: str = "plus"
        description: str = "This is a plus tool"
        parameters: ParametersType = {
            "type": "object",
            "properties": {
                "a": {"type": "integer"},
                "b": {"type": "integer"},
            },
        }

        @override
        async def __call__(self, a: int, b: int) -> ToolReturnValue:
            return ToolOk(output=str(a + b))

    plus_tool_call = ToolCall(
        id="plus#123",
        function=ToolCall.FunctionBody(name="plus", arguments='{"a": 1, "b": 2}'),
    )
    input_parts: list[StreamedMessagePart] = [
        TextPart(text="Hello, world!"),
        plus_tool_call,
    ]
    chat_provider = MockChatProvider(message_parts=input_parts)
    toolset = SimpleToolset([PlusTool()])

    output_parts: list[StreamedMessagePart] = []
    collected_tool_results: list[ToolResult] = []

    def on_message_part(part: StreamedMessagePart):
        output_parts.append(part)

    def on_tool_result(result: ToolResult):
        collected_tool_results.append(result)

    async def run():
        step_result = await step(
            chat_provider,
            system_prompt="",
            toolset=toolset,
            history=[],
            on_message_part=on_message_part,
            on_tool_result=on_tool_result,
        )
        tool_results = await step_result.tool_results()
        return step_result, tool_results

    step_result, tool_results = asyncio.run(run())
    assert step_result.message.content == [TextPart(text="Hello, world!")]
    assert step_result.tool_calls == [plus_tool_call]
    assert output_parts == input_parts
    assert tool_results == [ToolResult(tool_call_id="plus#123", return_value=ToolOk(output="3"))]
    assert collected_tool_results == tool_results

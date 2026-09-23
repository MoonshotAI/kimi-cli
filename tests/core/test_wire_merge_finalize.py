"""Regression: merged wire messages must flush deferred merge buffers."""

from __future__ import annotations

import asyncio

from kimi_cli.wire import Wire
from kimi_cli.wire.types import TextPart, ToolCall, ToolCallPart


async def test_wire_merged_text_includes_all_stream_fragments() -> None:
    wire = Wire()
    ui = wire.ui_side(merge=True)

    wire.soul_side.send(TextPart(text="Hello, "))
    wire.soul_side.send(TextPart(text="world"))
    wire.soul_side.send(TextPart(text="!"))
    wire.soul_side.flush()

    msg = await asyncio.wait_for(ui.receive(), timeout=1)
    assert isinstance(msg, TextPart)
    assert msg.text == "Hello, world!"

    wire.shutdown()


async def test_wire_merged_tool_call_includes_all_argument_fragments() -> None:
    wire = Wire()
    ui = wire.ui_side(merge=True)

    wire.soul_side.send(
        ToolCall(
            id="call_1",
            function=ToolCall.FunctionBody(name="Shell", arguments=None),
        )
    )
    wire.soul_side.send(ToolCallPart(arguments_part='{"command":'))
    wire.soul_side.send(ToolCallPart(arguments_part='"ls"}'))
    wire.soul_side.flush()

    msg = await asyncio.wait_for(ui.receive(), timeout=1)
    assert isinstance(msg, ToolCall)
    assert msg.function.arguments == '{"command":"ls"}'

    wire.shutdown()

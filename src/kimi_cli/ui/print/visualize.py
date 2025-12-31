import asyncio
from dataclasses import dataclass
from typing import Protocol

import rich
from kosong.message import ContentPart, Message, ToolCall, ToolCallPart
from kosong.tooling import ToolResult

from kimi_cli.cli import OutputFormat
from kimi_cli.soul.message import tool_result_to_message
from kimi_cli.wire import Wire
from kimi_cli.wire.message import StepBegin, StepInterrupted, WireMessage


class Printer(Protocol):
    def feed(self, msg: WireMessage) -> None: ...
    def flush(self) -> None: ...


def _merge_content(buffer: list[ContentPart], part: ContentPart) -> None:
    if not buffer or not buffer[-1].merge_in_place(part):
        buffer.append(part)


class TextPrinter(Printer):
    def feed(self, msg: WireMessage) -> None:
        rich.print(msg)

    def flush(self) -> None:
        pass


class JsonPrinter(Printer):
    @dataclass(slots=True)
    class _ToolCallState:
        tool_call: ToolCall
        tool_result: ToolResult | None

    def __init__(self) -> None:
        self._content_buffer: list[ContentPart] = []
        """The buffer to merge content parts."""
        self._tool_call_buffer: dict[str, JsonPrinter._ToolCallState] = {}
        """The buffer to store tool calls and their results."""
        self._last_tool_call: ToolCall | None = None

    def feed(self, msg: WireMessage) -> None:
        match msg:
            case StepBegin() | StepInterrupted():
                self.flush()
            case ContentPart() as part:
                # merge with previous parts as much as possible
                _merge_content(self._content_buffer, part)
            case ToolCall() as call:
                self._tool_call_buffer[call.id] = JsonPrinter._ToolCallState(
                    tool_call=call, tool_result=None
                )
                self._last_tool_call = call
            case ToolCallPart() as part:
                if self._last_tool_call is None:
                    return
                assert self._last_tool_call.merge_in_place(part)
            case ToolResult() as result:
                state = self._tool_call_buffer.get(result.tool_call_id)
                if state is None:
                    return
                state.tool_result = result
            case _:
                # ignore other messages
                pass

    def flush(self) -> None:
        if not self._content_buffer and not self._tool_call_buffer:
            return

        tool_calls: list[ToolCall] = []
        tool_results: list[ToolResult] = []
        for state in self._tool_call_buffer.values():
            if state.tool_result is None:
                # this should only happen when interrupted
                continue
            tool_calls.append(state.tool_call)
            tool_results.append(state.tool_result)

        message = Message(
            role="assistant",
            content=self._content_buffer,
            tool_calls=tool_calls or None,
        )
        print(message.model_dump_json(exclude_none=True), flush=True)

        for result in tool_results:
            # FIXME: this assumes the way how the soul convert `ToolResult` to `Message`
            message = tool_result_to_message(result)
            print(message.model_dump_json(exclude_none=True), flush=True)

        self._content_buffer.clear()
        self._tool_call_buffer.clear()


class FinalOnlyTextPrinter(Printer):
    def __init__(self) -> None:
        self._content_buffer: list[ContentPart] = []

    def feed(self, msg: WireMessage) -> None:
        match msg:
            case StepBegin() | StepInterrupted():
                self._content_buffer.clear()
            case ContentPart() as part:
                _merge_content(self._content_buffer, part)
            case _:
                pass

    def flush(self) -> None:
        if not self._content_buffer:
            return
        message = Message(role="assistant", content=self._content_buffer)
        text = message.extract_text()
        if text:
            print(text, flush=True)
        self._content_buffer.clear()


class FinalOnlyJsonPrinter(Printer):
    def __init__(self) -> None:
        self._content_buffer: list[ContentPart] = []

    def feed(self, msg: WireMessage) -> None:
        match msg:
            case StepBegin() | StepInterrupted():
                self._content_buffer.clear()
            case ContentPart() as part:
                _merge_content(self._content_buffer, part)
            case _:
                pass

    def flush(self) -> None:
        if not self._content_buffer:
            return
        message = Message(role="assistant", content=self._content_buffer)
        text = message.extract_text()
        if text:
            final_message = Message(role="assistant", content=text)
            print(final_message.model_dump_json(exclude_none=True), flush=True)
        self._content_buffer.clear()


async def visualize(output_format: OutputFormat, final_only: bool, wire: Wire) -> None:
    if final_only:
        match output_format:
            case "text":
                handler = FinalOnlyTextPrinter()
            case "stream-json":
                handler = FinalOnlyJsonPrinter()
    else:
        match output_format:
            case "text":
                handler = TextPrinter()
            case "stream-json":
                handler = JsonPrinter()

    wire_ui = wire.ui_side(merge=True)
    while True:
        try:
            msg = await wire_ui.receive()
        except asyncio.QueueShutDown:
            handler.flush()
            break

        handler.feed(msg)

        if isinstance(msg, StepInterrupted):
            break

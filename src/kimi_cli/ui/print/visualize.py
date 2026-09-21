from typing import Protocol

import rich
from kosong.message import Message

from kimi_cli.cli import OutputFormat
from kimi_cli.soul.message import tool_result_to_message
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import Wire
from kimi_cli.wire.types import (
    ContentPart,
    Notification,
    PlanDisplay,
    StepBegin,
    StepInterrupted,
    StepRetry,
    ToolCall,
    ToolCallPart,
    ToolResult,
    WireMessage,
)


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
    def __init__(self) -> None:
        self._content_buffer: list[ContentPart] = []
        """The buffer to merge content parts."""
        self._tool_call_buffer: list[ToolCall] = []
        """The buffer to store the current assistant message's tool calls."""
        self._pending_notifications: list[Notification] = []
        """Notifications buffered until the current assistant message reaches a safe boundary."""
        self._last_tool_call: ToolCall | None = None

    def feed(self, msg: WireMessage) -> None:
        match msg:
            case StepBegin() | StepInterrupted():
                self.flush()
            case StepRetry():
                self._discard_assistant_message()
                self._flush_notifications()
            case Notification() as notification:
                if self._content_buffer or self._tool_call_buffer:
                    self._pending_notifications.append(notification)
                else:
                    self._flush_assistant_message()
                    self._flush_notifications()
                    self._emit_notification(notification)
            case ContentPart() as part:
                # merge with previous parts as much as possible
                _merge_content(self._content_buffer, part)
            case ToolCall() as call:
                self._tool_call_buffer.append(call)
                self._last_tool_call = call
            case ToolCallPart() as part:
                if self._last_tool_call is None:
                    return
                assert self._last_tool_call.merge_in_place(part)
            case ToolResult() as result:
                self._flush_assistant_message()
                self._flush_notifications()
                message = tool_result_to_message(result)
                print(message.model_dump_json(exclude_none=True), flush=True)
            case PlanDisplay() as plan:
                self._flush_assistant_message()
                self._flush_notifications()
                print(plan.model_dump_json(exclude_none=True), flush=True)
            case _:
                # ignore other messages
                pass

    def _discard_assistant_message(self) -> None:
        self._content_buffer.clear()
        self._tool_call_buffer.clear()
        self._last_tool_call = None

    def _flush_assistant_message(self) -> None:
        if not self._content_buffer and not self._tool_call_buffer:
            return

        message = Message(
            role="assistant",
            content=self._content_buffer,
            tool_calls=self._tool_call_buffer or None,
        )
        print(message.model_dump_json(exclude_none=True), flush=True)

        self._content_buffer.clear()
        self._tool_call_buffer.clear()
        self._last_tool_call = None

    def _emit_notification(self, notification: Notification) -> None:
        print(notification.model_dump_json(exclude_none=True), flush=True)

    def _flush_notifications(self) -> None:
        for notification in self._pending_notifications:
            self._emit_notification(notification)
        self._pending_notifications.clear()

    def flush(self) -> None:
        self._flush_assistant_message()
        self._flush_notifications()


class FinalOnlyTextPrinter(Printer):
    def __init__(self) -> None:
        self._content_buffer: list[ContentPart] = []

    def feed(self, msg: WireMessage) -> None:
        match msg:
            case StepBegin() | StepInterrupted() | StepRetry():
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
            case StepBegin() | StepInterrupted() | StepRetry():
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
        except QueueShutDown:
            handler.flush()
            break

        handler.feed(msg)

        if isinstance(msg, StepInterrupted):
            break

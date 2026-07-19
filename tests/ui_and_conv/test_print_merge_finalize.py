"""Regression: print/stream-json must emit fully merged streamed content."""

from __future__ import annotations

import json

from kimi_cli.ui.print.visualize import FinalOnlyTextPrinter, JsonPrinter
from kimi_cli.wire.types import TextPart, ToolCall, ToolCallPart


def test_json_printer_emits_fully_merged_text(capsys) -> None:
    printer = JsonPrinter()
    printer.feed(TextPart(text="Hello, "))
    printer.feed(TextPart(text="world"))
    printer.feed(TextPart(text="!"))
    printer.flush()

    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["role"] == "assistant"
    assert payload["content"] == "Hello, world!"


def test_json_printer_emits_fully_merged_tool_arguments(capsys) -> None:
    printer = JsonPrinter()
    printer.feed(
        ToolCall(
            id="call_1",
            function=ToolCall.FunctionBody(name="Shell", arguments=None),
        )
    )
    printer.feed(ToolCallPart(arguments_part='{"command":'))
    printer.feed(ToolCallPart(arguments_part='"echo hi"}'))
    printer.flush()

    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["tool_calls"][0]["function"]["arguments"] == '{"command":"echo hi"}'


def test_final_only_text_printer_emits_fully_merged_text(capsys) -> None:
    printer = FinalOnlyTextPrinter()
    printer.feed(TextPart(text="Hello, "))
    printer.feed(TextPart(text="world!"))
    printer.flush()

    assert capsys.readouterr().out.strip() == "Hello, world!"

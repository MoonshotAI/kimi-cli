"""Tests for final-message-only print mode output."""

from __future__ import annotations

import json

from kosong.message import TextPart, ThinkPart

from kimi_cli.ui.print.visualize import FinalOnlyJsonPrinter, FinalOnlyTextPrinter
from kimi_cli.wire.message import StepBegin


def test_final_only_text_printer_outputs_final_text(capsys):
    printer = FinalOnlyTextPrinter()
    printer.feed(StepBegin(n=1))
    printer.feed(TextPart(text="first"))
    printer.feed(StepBegin(n=2))
    printer.feed(TextPart(text="final"))
    printer.feed(TextPart(text=" msg"))
    printer.flush()

    assert capsys.readouterr().out.strip() == "final msg"


def test_final_only_json_printer_outputs_final_message(capsys):
    printer = FinalOnlyJsonPrinter()
    printer.feed(StepBegin(n=1))
    printer.feed(TextPart(text="first"))
    printer.feed(StepBegin(n=2))
    printer.feed(ThinkPart(think="secret"))
    printer.feed(TextPart(text="final"))
    printer.flush()

    output = capsys.readouterr().out.strip()
    message = json.loads(output)
    assert message["role"] == "assistant"
    assert message["content"] == "final"

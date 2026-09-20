"""Regression tests for print-mode output on legacy stdout encodings."""

from __future__ import annotations

import io
import json
import sys

from kimi_cli.ui.print.visualize import JsonPrinter, TextPrinter
from kimi_cli.wire.types import TextPart


class _StrictEncodingStream(io.StringIO):
    encoding = "gbk"

    def write(self, text: str) -> int:
        text.encode(self.encoding)
        return super().write(text)


def test_json_printer_replaces_characters_unsupported_by_stdout(monkeypatch) -> None:
    stream = _StrictEncodingStream()
    monkeypatch.setattr(sys, "stdout", stream)

    printer = JsonPrinter()
    printer.feed(TextPart(text="model output \u0133"))
    printer.flush()

    output = stream.getvalue()
    output.encode(stream.encoding)
    payload = json.loads(output)
    assert payload["content"] == "model output ?"


def test_text_printer_replaces_characters_unsupported_by_stdout(monkeypatch) -> None:
    stream = _StrictEncodingStream()
    monkeypatch.setattr(sys, "stdout", stream)

    TextPrinter().feed(TextPart(text="model output \u0133"))

    output = stream.getvalue()
    output.encode(stream.encoding)
    assert "model output ?" in output

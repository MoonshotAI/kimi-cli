"""Regression tests for print-mode output on legacy stdout encodings."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from kosong.chat_provider import APIConnectionError, ChatProviderError

from kimi_cli.cli import ExitCode
from kimi_cli.ui.print import Print
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


@pytest.mark.asyncio
async def test_print_run_echo_replaces_unsupported_characters(monkeypatch, tmp_path: Path) -> None:
    stream = _StrictEncodingStream()
    monkeypatch.setattr(sys, "stdout", stream)
    run_soul = AsyncMock()
    monkeypatch.setattr("kimi_cli.ui.print.run_soul", run_soul)
    app = Print(AsyncMock(), "text", "text", tmp_path / "context.json")

    assert await app.run("explain \U0001f9ea 中文") == ExitCode.SUCCESS

    run_soul.assert_awaited_once()
    assert "explain ? 中文" in stream.getvalue()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "exit_code"),
    [
        (ChatProviderError("provider \U0001f9ea 中文"), ExitCode.FAILURE),
        (APIConnectionError("connection \U0001f9ea 中文"), ExitCode.RETRYABLE),
    ],
)
async def test_print_run_error_replaces_unsupported_characters(
    monkeypatch, tmp_path: Path, error: ChatProviderError, exit_code: int
) -> None:
    stream = _StrictEncodingStream()
    monkeypatch.setattr(sys, "stdout", stream)
    monkeypatch.setattr("kimi_cli.ui.print.run_soul", AsyncMock(side_effect=error))
    app = Print(AsyncMock(), "text", "text", tmp_path / "context.json")

    assert await app.run("hello") == exit_code
    assert "? 中文" in stream.getvalue()


@pytest.mark.asyncio
async def test_print_run_unknown_error_preserves_original_exception(
    monkeypatch, tmp_path: Path
) -> None:
    stream = _StrictEncodingStream()
    monkeypatch.setattr(sys, "stdout", stream)
    error = RuntimeError("unexpected \U0001f9ea 中文")
    monkeypatch.setattr("kimi_cli.ui.print.run_soul", AsyncMock(side_effect=error))
    app = Print(AsyncMock(), "text", "text", tmp_path / "context.json")

    with pytest.raises(RuntimeError) as caught:
        await app.run("hello")
    assert caught.value is error
    assert "Unknown error: unexpected ? 中文" in stream.getvalue()

"""Tests for /copy slash command."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from kosong.message import Message, TextPart, ThinkPart
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.slash import copy
from kimi_cli.wire.types import TextPart as WireTextPart


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


async def _run_copy(soul: KimiSoul) -> None:
    result = copy(soul, "")
    if result is not None:
        await result


class TestCopySlashCommand:
    async def test_copy_no_assistant_message(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        soul = _make_soul(runtime, tmp_path)
        sent: list[WireTextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        await _run_copy(soul)

        assert any("No assistant response to copy" in s.text for s in sent)

    async def test_copy_text_only(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        soul = _make_soul(runtime, tmp_path)
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="Hello, world!")])
        )

        sent: list[WireTextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        with patch("kimi_cli.utils.clipboard.copy_text_to_clipboard") as mock_copy:
            await _run_copy(soul)

        mock_copy.assert_called_once_with("Hello, world!")
        assert any("Copied the latest assistant response" in s.text for s in sent)

    async def test_copy_with_thinking(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        soul = _make_soul(runtime, tmp_path)
        await soul.context.append_message(
            Message(
                role="assistant",
                content=[
                    ThinkPart(think="I should say hello."),
                    TextPart(text="Hello, world!"),
                ],
            )
        )

        sent: list[WireTextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        with patch("kimi_cli.utils.clipboard.copy_text_to_clipboard") as mock_copy:
            await _run_copy(soul)

        copied = mock_copy.call_args[0][0]
        assert "I should say hello." in copied
        assert "Hello, world!" in copied
        assert any("Copied the latest assistant response" in s.text for s in sent)

    async def test_copy_latest_assistant_only(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        soul = _make_soul(runtime, tmp_path)
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="First response")])
        )
        await soul.context.append_message(
            Message(role="user", content=[TextPart(text="Follow up")])
        )
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="Second response")])
        )

        sent: list[WireTextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))

        with patch("kimi_cli.utils.clipboard.copy_text_to_clipboard") as mock_copy:
            await _run_copy(soul)

        mock_copy.assert_called_once_with("Second response")
        assert any("Copied the latest assistant response" in s.text for s in sent)

    async def test_copy_clipboard_unavailable(
        self, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        soul = _make_soul(runtime, tmp_path)
        await soul.context.append_message(
            Message(role="assistant", content=[TextPart(text="Hello")])
        )

        sent: list[WireTextPart] = []
        monkeypatch.setattr("kimi_cli.soul.slash.wire_send", lambda msg: sent.append(msg))
        monkeypatch.setattr("kimi_cli.utils.clipboard.is_clipboard_available", lambda: False)

        with patch("kimi_cli.utils.clipboard.copy_text_to_clipboard") as mock_copy:
            await _run_copy(soul)

        mock_copy.assert_not_called()
        assert any("Clipboard is not available" in s.text for s in sent)

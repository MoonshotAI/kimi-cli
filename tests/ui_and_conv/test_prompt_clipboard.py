from __future__ import annotations

import shlex
from pathlib import Path
from types import SimpleNamespace
from typing import cast

from prompt_toolkit.key_binding import KeyPressEvent

from kimi_cli.ui.shell import prompt as shell_prompt
from kimi_cli.ui.shell.prompt import PromptMode
from kimi_cli.utils.clipboard import ClipboardVideo


class _DummyBuffer:
    def __init__(self) -> None:
        self.inserted: list[str] = []

    def insert_text(self, text: str) -> None:
        self.inserted.append(text)


class _DummyApp:
    def __init__(self) -> None:
        self.invalidated = False

    def invalidate(self) -> None:
        self.invalidated = True


def test_try_paste_media_quotes_video_path_in_shell_mode(monkeypatch) -> None:
    video_path = Path("/tmp/My Clip (final).mp4")
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardVideo(path=video_path),
    )

    prompt_session = object.__new__(shell_prompt.CustomPromptSession)
    prompt_session._mode = PromptMode.SHELL

    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = prompt_session._try_paste_media(cast(KeyPressEvent, event))

    assert result is True
    assert buffer.inserted == [shlex.quote(str(video_path))]
    assert app.invalidated is True


def test_try_paste_media_quotes_single_quote_in_shell_mode(monkeypatch) -> None:
    video_path = Path("/tmp/it's ok.mp4")
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardVideo(path=video_path),
    )

    prompt_session = object.__new__(shell_prompt.CustomPromptSession)
    prompt_session._mode = PromptMode.SHELL

    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = prompt_session._try_paste_media(cast(KeyPressEvent, event))

    assert result is True
    assert buffer.inserted == [shlex.quote(str(video_path))]
    assert app.invalidated is True


def test_try_paste_media_keeps_raw_video_path_in_agent_mode(monkeypatch) -> None:
    video_path = Path("/tmp/My Clip (final).mp4")
    monkeypatch.setattr(
        shell_prompt,
        "grab_media_from_clipboard",
        lambda: ClipboardVideo(path=video_path),
    )

    prompt_session = object.__new__(shell_prompt.CustomPromptSession)
    prompt_session._mode = PromptMode.AGENT

    buffer = _DummyBuffer()
    app = _DummyApp()
    event = SimpleNamespace(current_buffer=buffer, app=app)

    result = prompt_session._try_paste_media(cast(KeyPressEvent, event))

    assert result is True
    assert buffer.inserted == [str(video_path)]
    assert app.invalidated is True

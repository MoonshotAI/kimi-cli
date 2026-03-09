from __future__ import annotations

import asyncio
import importlib
from types import SimpleNamespace
from typing import cast

from prompt_toolkit.key_binding import KeyPressEvent

from kimi_cli.ui.shell import prompt as shell_prompt


class _DummyApp:
    def __init__(self) -> None:
        self.tasks: list[asyncio.Task[None]] = []

    def create_background_task(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.append(task)
        return task


class _DummyBuffer:
    def __init__(self, text: str) -> None:
        self.text = text
        self.document = None


async def test_open_in_external_editor_uses_provider_value(monkeypatch) -> None:
    configured_editor = "vim -u NONE"
    prompt_session = object.__new__(shell_prompt.CustomPromptSession)
    prompt_session._editor_command_provider = lambda: configured_editor

    app = _DummyApp()
    buff = _DummyBuffer("hello world")
    event = SimpleNamespace(current_buffer=buff, app=app)

    get_editor_calls: list[str] = []
    edit_calls: list[tuple[str, str]] = []

    def fake_get_editor_command(configured: str | None = None):
        get_editor_calls.append(configured or "")
        return ["vim"]

    def fake_edit_text_in_editor(text: str, configured: str | None = None):
        edit_calls.append((text, configured or ""))
        return "edited content"

    async def fake_run_in_terminal(func, in_executor=True):
        assert in_executor is True
        return func()

    monkeypatch.setattr("kimi_cli.utils.editor.get_editor_command", fake_get_editor_command)
    monkeypatch.setattr("kimi_cli.utils.editor.edit_text_in_editor", fake_edit_text_in_editor)
    run_in_terminal_module = importlib.import_module("prompt_toolkit.application.run_in_terminal")
    monkeypatch.setattr(run_in_terminal_module, "run_in_terminal", fake_run_in_terminal)

    prompt_session._open_in_external_editor(cast(KeyPressEvent, event))
    assert get_editor_calls == [configured_editor]
    assert len(app.tasks) == 1

    await asyncio.gather(*app.tasks)

    assert edit_calls == [("hello world", configured_editor)]
    assert buff.document is not None
    assert buff.document.text == "edited content"
    assert buff.document.cursor_position == len("edited content")


def test_open_in_external_editor_toast_when_no_editor(monkeypatch) -> None:
    configured_editor = "non-existent-editor"
    prompt_session = object.__new__(shell_prompt.CustomPromptSession)
    prompt_session._editor_command_provider = lambda: configured_editor

    app = _DummyApp()
    buff = _DummyBuffer("hello world")
    event = SimpleNamespace(current_buffer=buff, app=app)

    toast_calls: list[str] = []

    def fake_toast(message: str, *_, **__):
        toast_calls.append(message)

    monkeypatch.setattr("kimi_cli.utils.editor.get_editor_command", lambda configured=None: None)
    monkeypatch.setattr(shell_prompt, "toast", fake_toast)

    prompt_session._open_in_external_editor(cast(KeyPressEvent, event))

    assert toast_calls == ["No editor found. Set $VISUAL/$EDITOR or run /editor."]
    assert app.tasks == []
    assert buff.document is None

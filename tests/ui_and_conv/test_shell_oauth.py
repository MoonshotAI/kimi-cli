from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.auth.oauth import OAuthEvent
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell import Shell
from kimi_cli.ui.shell import oauth as shell_oauth


def _make_shell(runtime: Runtime, tmp_path: Path) -> Shell:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    return Shell(soul)


class _DummyStatus:
    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None


class _FakePromptSession:
    def __init__(self) -> None:
        self.modals: list[object] = []
        self.prompt_calls = 0

    def attach_modal(self, delegate: object) -> None:
        self.modals.append(delegate)

    def detach_modal(self, delegate: object) -> None:
        self.modals.remove(delegate)

    def invalidate(self) -> None:
        return None

    async def prompt_next(self) -> None:
        self.prompt_calls += 1
        await asyncio.Event().wait()


@pytest.mark.asyncio
async def test_shell_login_escape_cancels_waiting_oauth_flow(
    runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    shell = _make_shell(runtime, tmp_path)
    prompt_session = _FakePromptSession()
    shell._prompt_session = prompt_session  # pyright: ignore[reportPrivateUsage]

    cancel_events: list[asyncio.Event | None] = []

    async def _fake_login_kimi_code(config, *, open_browser=True, cancel_event=None):
        cancel_events.append(cancel_event)
        yield OAuthEvent("waiting", "Waiting for user authorization...")
        assert cancel_event is not None
        await cancel_event.wait()
        raise asyncio.CancelledError()

    monkeypatch.setattr(shell_oauth, "login_kimi_code", _fake_login_kimi_code)
    monkeypatch.setattr(shell_oauth.console, "status", lambda *_args, **_kwargs: _DummyStatus())
    monkeypatch.setattr(shell_oauth.console, "print", lambda *args, **kwargs: None)

    task = asyncio.create_task(shell_oauth._login_kimi_code(shell, shell.soul))

    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert prompt_session.prompt_calls > 0
    assert len(prompt_session.modals) == 1

    prompt_session.modals[0].handle_running_prompt_key(  # pyright: ignore[reportAttributeAccessIssue]
        "escape",
        SimpleNamespace(app=None, current_buffer=None),
    )

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=1.0)

    assert len(cancel_events) == 1
    assert cancel_events[0] is not None and cancel_events[0].is_set()
    assert prompt_session.modals == []

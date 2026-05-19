from __future__ import annotations

import asyncio

import pytest
from kaos.path import KaosPath

from kimi_cli.tools.shell import Shell
from kimi_cli.utils.environment import Environment


class _NullStdin:
    def close(self) -> None:
        pass


class _BlockingReadable:
    def __init__(self, started: asyncio.Event) -> None:
        self._started = started

    async def readline(self) -> bytes:
        self._started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


class _FakeProcess:
    stdin = _NullStdin()

    def __init__(self, started: asyncio.Event) -> None:
        self.stdout = _BlockingReadable(started)
        self.stderr = _BlockingReadable(started)
        self.kill_calls = 0

    async def wait(self) -> int:
        return 0

    async def kill(self) -> None:
        self.kill_calls += 1


def _make_shell(approval, runtime) -> Shell:
    env = Environment(
        os_kind="Linux",
        os_arch="x86_64",
        os_version="1.0",
        shell_name="bash",
        shell_path=KaosPath("/bin/bash"),
    )
    return Shell(approval, env, runtime)


async def test_foreground_shell_uses_new_session_and_kills_on_cancel(
    approval,
    runtime,
    monkeypatch: pytest.MonkeyPatch,
):
    started = asyncio.Event()
    fake_process = _FakeProcess(started)
    exec_kwargs: list[dict] = []

    async def fake_exec(*_args, **kwargs) -> _FakeProcess:
        exec_kwargs.append(kwargs)
        return fake_process

    monkeypatch.setattr("kimi_cli.tools.shell.kaos.exec", fake_exec)
    shell = _make_shell(approval, runtime)

    task = asyncio.create_task(
        shell._run_shell_command("sleep 10", lambda _line: None, lambda _line: None, 60)
    )
    await asyncio.wait_for(started.wait(), timeout=1.0)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert exec_kwargs[0]["start_new_session"] is True
    assert fake_process.kill_calls == 1

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell import Shell
from kimi_cli.ui.shell import slash as shell_slash


def _make_shell_app(runtime: Runtime, tmp_path: Path) -> SimpleNamespace:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    return SimpleNamespace(soul=soul)


def test_task_command_registered_in_shell_registries() -> None:
    assert shell_slash.registry.find_command("task") is not None
    assert shell_slash.shell_mode_registry.find_command("task") is not None


@pytest.mark.asyncio
async def test_task_command_rejects_args(runtime: Runtime, tmp_path: Path, monkeypatch) -> None:
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    await shell_slash.task(app, "unexpected")  # type: ignore[arg-type]

    print_mock.assert_called_once()
    assert 'Usage: "/task"' in str(print_mock.call_args.args[0])


@pytest.mark.asyncio
async def test_task_command_requires_root_role(
    runtime: Runtime, tmp_path: Path, monkeypatch
) -> None:
    runtime.role = "fixed_subagent"
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    await shell_slash.task(app, "")  # type: ignore[arg-type]

    print_mock.assert_called_once()
    assert "root agent" in str(print_mock.call_args.args[0])


@pytest.mark.asyncio
async def test_task_command_launches_browser(runtime: Runtime, tmp_path: Path, monkeypatch) -> None:
    app = _make_shell_app(runtime, tmp_path)
    run_mock = Mock()

    class _FakeTaskBrowserApp:
        def __init__(self, soul: KimiSoul):
            assert soul is app.soul

        async def run(self) -> None:
            run_mock()

    monkeypatch.setattr(shell_slash, "TaskBrowserApp", _FakeTaskBrowserApp)

    await shell_slash.task(app, "")  # type: ignore[arg-type]

    run_mock.assert_called_once()


class TestShellBackgroundTaskCleanup:
    """Verify that Shell cancels background tasks (notification watcher, etc.) on exit."""

    def _make_shell(self, runtime: Runtime, tmp_path: Path) -> Shell:
        agent = Agent(
            name="Test Agent",
            system_prompt="Test system prompt.",
            toolset=EmptyToolset(),
            runtime=runtime,
        )
        soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
        return Shell(soul)

    @pytest.mark.asyncio
    async def test_cancel_background_tasks_cancels_all_tasks(
        self, runtime: Runtime, tmp_path: Path
    ) -> None:
        shell = self._make_shell(runtime, tmp_path)

        async def _forever() -> None:
            await asyncio.Event().wait()

        task1 = shell._start_background_task(_forever())
        task2 = shell._start_background_task(_forever())
        assert not task1.done()
        assert not task2.done()

        shell._cancel_background_tasks()

        # Yield control so cancellation propagates
        await asyncio.sleep(0)

        assert task1.cancelled()
        assert task2.cancelled()
        assert len(shell._background_tasks) == 0

    @pytest.mark.asyncio
    async def test_cancel_background_tasks_is_idempotent(
        self, runtime: Runtime, tmp_path: Path
    ) -> None:
        shell = self._make_shell(runtime, tmp_path)

        async def _forever() -> None:
            await asyncio.Event().wait()

        shell._start_background_task(_forever())
        shell._cancel_background_tasks()
        await asyncio.sleep(0)
        shell._cancel_background_tasks()  # second call should not raise

        assert len(shell._background_tasks) == 0

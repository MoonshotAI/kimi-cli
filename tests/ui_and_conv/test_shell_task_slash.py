from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
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

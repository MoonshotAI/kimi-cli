from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

import kimi_cli.app as app_module
import kimi_cli.ui.shell.startup as startup_module
from kimi_cli.app import KimiCLI
from kimi_cli.ui.shell.startup import ShellStartupProgress


def test_shell_startup_progress_starts_once_and_updates_messages(monkeypatch) -> None:
    events: list[tuple[str, str]] = []

    class FakeStatus:
        def start(self) -> None:
            events.append(("start", ""))

        def update(self, message: str) -> None:
            events.append(("update", message))

        def stop(self) -> None:
            events.append(("stop", ""))

    def fake_status(message: str, *, spinner: str) -> FakeStatus:
        events.append(("create", message))
        assert spinner == "dots"
        return FakeStatus()

    monkeypatch.setattr(startup_module.console, "status", fake_status)

    progress = ShellStartupProgress(enabled=True)
    progress.update("Preparing session...")
    progress.update("Loading agent...")
    progress.stop()

    assert events == [
        ("create", "[cyan]Preparing session...[/cyan]"),
        ("start", ""),
        ("update", "[cyan]Loading agent...[/cyan]"),
        ("stop", ""),
    ]


def test_shell_startup_progress_is_noop_when_disabled(monkeypatch) -> None:
    called = False

    def fake_status(message: str, *, spinner: str):
        nonlocal called
        called = True
        raise AssertionError(f"status() should not be called, got {message!r} {spinner!r}")

    monkeypatch.setattr(startup_module.console, "status", fake_status)

    progress = ShellStartupProgress(enabled=False)
    progress.update("Preparing session...")
    progress.stop()

    assert called is False


@pytest.mark.asyncio
async def test_kimi_cli_create_reports_startup_phases(session, config, monkeypatch) -> None:
    phases: list[str] = []
    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=None,
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
    )
    fake_agent = SimpleNamespace(name="Test Agent", system_prompt="Test system prompt")
    fake_context = SimpleNamespace(system_prompt=None)
    write_system_prompt = AsyncMock()

    async def fake_runtime_create(*args, **kwargs):
        return fake_runtime

    async def fake_load_agent(*args, **kwargs):
        return fake_agent

    async def fake_restore() -> None:
        return None

    fake_context.restore = fake_restore
    fake_context.write_system_prompt = write_system_prompt

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(app_module, "create_llm", lambda *args, **kwargs: None)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(app_module, "load_agent", fake_load_agent)
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)

    class _FakeSoul:
        def __init__(self, agent, context):
            pass

        def set_hook_engine(self, engine):
            pass

    monkeypatch.setattr(app_module, "KimiSoul", _FakeSoul)

    cli = await KimiCLI.create(session, config=config, startup_progress=phases.append)

    assert isinstance(cli, KimiCLI)
    assert phases == [
        "Loading configuration...",
        "Scanning workspace...",
        "Loading agent...",
        "Restoring conversation...",
    ]
    write_system_prompt.assert_awaited_once_with("Test system prompt")


@pytest.mark.asyncio
async def test_kimi_cli_create_cleans_stale_running_foreground_subagents(
    session, config, monkeypatch
) -> None:
    update_instance = Mock()
    fake_runtime = SimpleNamespace(
        session=session,
        config=config,
        llm=None,
        notifications=SimpleNamespace(recover=lambda: None),
        background_tasks=SimpleNamespace(reconcile=lambda: None),
        subagent_store=SimpleNamespace(
            list_instances=lambda: [
                SimpleNamespace(agent_id="afg1", status="running_foreground"),
                SimpleNamespace(agent_id="abg1", status="running_background"),
                SimpleNamespace(agent_id="aidle1", status="idle"),
            ],
            update_instance=update_instance,
        ),
    )
    fake_agent = SimpleNamespace(name="Test Agent", system_prompt="Test system prompt")
    fake_context = SimpleNamespace(system_prompt=None)
    write_system_prompt = AsyncMock()

    async def fake_runtime_create(*args, **kwargs):
        return fake_runtime

    async def fake_load_agent(*args, **kwargs):
        return fake_agent

    async def fake_restore() -> None:
        return None

    fake_context.restore = fake_restore
    fake_context.write_system_prompt = write_system_prompt

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
    monkeypatch.setattr(app_module, "create_llm", lambda *args, **kwargs: None)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(app_module, "load_agent", fake_load_agent)
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)

    class _FakeSoul:
        def __init__(self, agent, context):
            pass

        def set_hook_engine(self, engine):
            pass

    monkeypatch.setattr(app_module, "KimiSoul", _FakeSoul)

    await KimiCLI.create(session, config=config)

    update_instance.assert_called_once_with("afg1", status="failed")

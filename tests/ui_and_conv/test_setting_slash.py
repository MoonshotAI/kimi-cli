"""Tests for /setting slash command."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, Mock, patch

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.cli import Reload
from kimi_cli.config import get_default_config
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell import Shell
from kimi_cli.ui.shell import slash as shell_slash
from kimi_cli.ui.shell.settings_app import SettingsApp
from kimi_cli.ui.shell.slash import setting as _setting_func
from kimi_cli.ui.theme import get_active_theme

setting_cmd = cast(Callable[[Shell, str], Awaitable[None]], _setting_func)


def _make_shell_app(runtime: Runtime, tmp_path: Path) -> SimpleNamespace:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    return SimpleNamespace(soul=soul)


def test_setting_command_registered_in_both_registries():
    from kimi_cli.ui.shell.slash import registry, shell_mode_registry

    agent_cmds = {c.name for c in registry.list_commands()}
    shell_cmds = {c.name for c in shell_mode_registry.list_commands()}
    assert "setting" in agent_cmds
    assert "setting" in shell_cmds
    assert "settings" in {a for c in registry.list_commands() for a in c.aliases}


async def test_setting_rejects_inline_config(runtime: Runtime, tmp_path: Path, monkeypatch):
    runtime.config.source_file = None
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    await setting_cmd(cast(Shell, app), "")

    assert "config file" in str(print_mock.call_args.args[0]).lower()


async def test_setting_model_choice_triggers_reload(runtime: Runtime, tmp_path: Path, monkeypatch):
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    runtime.config.is_from_default_location = True
    app = _make_shell_app(runtime, tmp_path)

    monkeypatch.setattr(shell_slash.console, "print", Mock())

    # SettingsApp returns model -> then _pick_model_and_thinking picks a model
    with patch("kimi_cli.ui.shell.settings_app.SettingsApp", spec=SettingsApp) as MockApp:
        instance = MockApp.return_value
        instance.run = AsyncMock(return_value="model")
        instance.needs_reload = False
        with (
            patch.object(
                shell_slash,
                "_pick_model_and_thinking",
                return_value=("kimi-k2", False),
            ),
            patch.object(
                shell_slash,
                "_switch_model_and_thinking",
                side_effect=Reload(session_id=runtime.session.id),
            ),
            pytest.raises(Reload),
        ):
            await setting_cmd(cast(Shell, app), "")


async def test_setting_theme_reload_via_tui(runtime: Runtime, tmp_path: Path, monkeypatch):
    from kimi_cli.ui.theme import set_active_theme

    set_active_theme("dark")
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    monkeypatch.setattr(shell_slash.console, "print", Mock())

    with patch("kimi_cli.ui.shell.settings_app.SettingsApp", spec=SettingsApp) as MockApp:
        instance = MockApp.return_value
        instance.run = AsyncMock(return_value=None)
        instance.needs_reload = True
        with pytest.raises(Reload):
            await setting_cmd(cast(Shell, app), "")

    set_active_theme("dark")


async def test_setting_editor_persists(runtime: Runtime, tmp_path: Path, monkeypatch):
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    config_for_save = get_default_config()
    monkeypatch.setattr(shell_slash, "load_config", Mock(return_value=config_for_save))
    monkeypatch.setattr(shell_slash, "save_config", Mock())
    monkeypatch.setattr(shell_slash.console, "print", Mock())

    with patch("kimi_cli.ui.shell.settings_app.SettingsApp", spec=SettingsApp) as MockApp:
        instance = MockApp.return_value
        # First run selects editor, second run user exits with Esc
        instance.run = AsyncMock(side_effect=["editor", None])
        instance.needs_reload = False
        with patch.object(
            shell_slash.ChoiceInput,
            "prompt_async",
            return_value="vim",
        ):
            await setting_cmd(cast(Shell, app), "")

    assert config_for_save.default_editor == "vim"
    assert runtime.config.default_editor == "vim"


async def test_setting_yolo_toggles_via_tui(runtime: Runtime, tmp_path: Path, monkeypatch):
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    monkeypatch.setattr(shell_slash.console, "print", Mock())

    with patch("kimi_cli.ui.shell.settings_app.SettingsApp", spec=SettingsApp) as MockApp:
        instance = MockApp.return_value
        instance.run = AsyncMock(return_value=None)
        instance.needs_reload = False
        # Simulate that SettingsApp turned yolo on inside the TUI
        app.soul.runtime.approval.set_yolo(True)
        runtime.config.default_yolo = True
        await setting_cmd(cast(Shell, app), "")

    assert runtime.approval.is_yolo() is True
    assert runtime.config.default_yolo is True


async def test_setting_plan_mode_toggles_via_tui(runtime: Runtime, tmp_path: Path, monkeypatch):
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    monkeypatch.setattr(shell_slash.console, "print", Mock())

    with patch("kimi_cli.ui.shell.settings_app.SettingsApp", spec=SettingsApp) as MockApp:
        instance = MockApp.return_value
        instance.run = AsyncMock(return_value=None)
        instance.needs_reload = False
        # Simulate that SettingsApp turned plan mode on inside the TUI
        runtime.config.default_plan_mode = True
        if not app.soul.plan_mode:
            await app.soul.toggle_plan_mode_from_manual()
        await setting_cmd(cast(Shell, app), "")

    assert runtime.config.default_plan_mode is True
    assert app.soul.plan_mode is True


async def test_setting_show_thinking_stream_toggles_via_tui(
    runtime: Runtime, tmp_path: Path, monkeypatch
):
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    runtime.config.show_thinking_stream = False
    app = _make_shell_app(runtime, tmp_path)

    monkeypatch.setattr(shell_slash.console, "print", Mock())

    with patch("kimi_cli.ui.shell.settings_app.SettingsApp", spec=SettingsApp) as MockApp:
        instance = MockApp.return_value
        instance.run = AsyncMock(return_value=None)
        instance.needs_reload = False
        # Simulate that SettingsApp turned show_thinking_stream on inside the TUI
        runtime.config.show_thinking_stream = True
        await setting_cmd(cast(Shell, app), "")

    assert runtime.config.show_thinking_stream is True


async def test_setting_theme_save_failure_no_reload(runtime: Runtime, tmp_path: Path, monkeypatch):
    from kimi_cli.ui.theme import set_active_theme

    set_active_theme("dark")
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    with patch("kimi_cli.ui.shell.settings_app.SettingsApp", spec=SettingsApp) as MockApp:
        instance = MockApp.return_value
        instance.run = AsyncMock(return_value=None)
        instance.needs_reload = False
        # Should NOT raise Reload
        await setting_cmd(cast(Shell, app), "")

    assert get_active_theme() == "dark"

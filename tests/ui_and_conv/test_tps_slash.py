"""Tests for /tps slash command."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import Mock

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.config import get_default_config
from kimi_cli.exception import ConfigError
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell import Shell
from kimi_cli.ui.shell import slash as shell_slash
from kimi_cli.ui.tps_meter import get_show_tps_meter, set_show_tps_meter


@pytest.fixture(autouse=True)
def _reset_tps_meter():
    set_show_tps_meter(False)
    yield
    set_show_tps_meter(False)


def _make_shell_app(runtime: Runtime, tmp_path: Path) -> SimpleNamespace:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    return SimpleNamespace(soul=soul)


def test_tps_command_registered_in_both_registries():
    """/tps should be available in both agent and shell registries."""
    from kimi_cli.ui.shell.slash import registry, shell_mode_registry

    agent_cmds = {c.name for c in registry.list_commands()}
    shell_cmds = {c.name for c in shell_mode_registry.list_commands()}
    assert "tps" in agent_cmds
    assert "tps" in shell_cmds


def test_tps_no_args_shows_current(runtime: Runtime, tmp_path: Path, monkeypatch):
    """/tps with no args should show current status."""
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    set_show_tps_meter(False)
    shell_slash.tps(cast(Shell, app), "")

    assert print_mock.call_count == 2
    assert "off" in str(print_mock.call_args_list[0].args[0]).lower()


def test_tps_invalid_arg(runtime: Runtime, tmp_path: Path, monkeypatch):
    """/tps with invalid arg should show error."""
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    shell_slash.tps(cast(Shell, app), "invalid")

    assert "Invalid argument" in str(print_mock.call_args.args[0])


def test_tps_same_as_current(runtime: Runtime, tmp_path: Path, monkeypatch):
    """/tps with same value should show 'already' message."""
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    set_show_tps_meter(False)
    shell_slash.tps(cast(Shell, app), "off")

    assert "already" in str(print_mock.call_args.args[0]).lower()


def test_tps_on_enables_and_persists(runtime: Runtime, tmp_path: Path, monkeypatch):
    """/tps on should enable meter and persist to config."""
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    config_for_save = get_default_config()
    load_mock = Mock(return_value=config_for_save)
    save_mock = Mock()
    monkeypatch.setattr(shell_slash, "load_config", load_mock)
    monkeypatch.setattr(shell_slash, "save_config", save_mock)
    monkeypatch.setattr(shell_slash.console, "print", Mock())

    set_show_tps_meter(False)
    shell_slash.tps(cast(Shell, app), "on")

    load_mock.assert_called_once_with(config_path)
    save_mock.assert_called_once()
    assert config_for_save.show_tps_meter is True
    assert get_show_tps_meter() is True  # In-memory state updated


def test_tps_off_disables_and_persists(runtime: Runtime, tmp_path: Path, monkeypatch):
    """/tps off should disable meter and persist to config."""
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    config_for_save = get_default_config()
    config_for_save.show_tps_meter = True
    load_mock = Mock(return_value=config_for_save)
    save_mock = Mock()
    monkeypatch.setattr(shell_slash, "load_config", load_mock)
    monkeypatch.setattr(shell_slash, "save_config", save_mock)
    monkeypatch.setattr(shell_slash.console, "print", Mock())

    set_show_tps_meter(True)
    shell_slash.tps(cast(Shell, app), "off")

    assert config_for_save.show_tps_meter is False
    assert get_show_tps_meter() is False


def test_tps_save_failure_no_state_change(runtime: Runtime, tmp_path: Path, monkeypatch):
    """If save fails, in-memory state should not change."""
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    set_show_tps_meter(False)

    load_mock = Mock(side_effect=ConfigError("Disk full"))
    monkeypatch.setattr(shell_slash, "load_config", load_mock)
    save_mock = Mock()
    monkeypatch.setattr(shell_slash, "save_config", save_mock)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    shell_slash.tps(cast(Shell, app), "on")

    assert get_show_tps_meter() is False  # Unchanged
    save_mock.assert_not_called()
    assert "Failed" in str(print_mock.call_args.args[0])


def test_tps_rejects_inline_config(runtime: Runtime, tmp_path: Path, monkeypatch):
    """/tps should warn when config file is None (inline config)."""
    runtime.config.source_file = None
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    shell_slash.tps(cast(Shell, app), "on")

    assert "config file" in str(print_mock.call_args.args[0]).lower()


def test_tps_whitespace_and_case_handling(runtime: Runtime, tmp_path: Path, monkeypatch):
    """Arguments are stripped and lowercased: '  ON  ' should work."""
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    config_for_save = get_default_config()
    load_mock = Mock(return_value=config_for_save)
    save_mock = Mock()
    monkeypatch.setattr(shell_slash, "load_config", load_mock)
    monkeypatch.setattr(shell_slash, "save_config", save_mock)
    monkeypatch.setattr(shell_slash.console, "print", Mock())

    set_show_tps_meter(False)
    # Test with extra whitespace and uppercase
    shell_slash.tps(cast(Shell, app), "  ON  ")

    assert config_for_save.show_tps_meter is True
    assert get_show_tps_meter() is True

    # Test OFF with mixed case
    shell_slash.tps(cast(Shell, app), "Off")
    assert config_for_save.show_tps_meter is False
    assert get_show_tps_meter() is False

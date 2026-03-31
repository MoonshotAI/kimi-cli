"""Tests for terminal theme system (ui/theme.py) and /theme slash command."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import Mock

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.cli import Reload
from kimi_cli.config import Config, get_default_config
from kimi_cli.exception import ConfigError
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell import Shell
from kimi_cli.ui.shell import slash as shell_slash
from kimi_cli.ui.theme import (
    get_active_theme,
    get_diff_colors,
    get_mcp_prompt_colors,
    get_prompt_style,
    get_task_browser_style,
    get_toolbar_colors,
    set_active_theme,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_theme():
    """Ensure every test starts and ends with dark theme."""
    set_active_theme("dark")
    yield
    set_active_theme("dark")


def _make_shell_app(runtime: Runtime, tmp_path: Path) -> SimpleNamespace:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    return SimpleNamespace(soul=soul)


# ---------------------------------------------------------------------------
# Theme module: set/get and color resolution
# ---------------------------------------------------------------------------


def test_set_and_get_active_theme():
    assert get_active_theme() == "dark"
    set_active_theme("light")
    assert get_active_theme() == "light"
    set_active_theme("dark")
    assert get_active_theme() == "dark"


@pytest.mark.parametrize(
    ("theme", "expected_add_bg_fragment"),
    [("dark", "#12261e"), ("light", "#dafbe1")],
)
def test_diff_colors_by_theme(theme: str, expected_add_bg_fragment: str):
    set_active_theme(theme)  # type: ignore[arg-type]
    colors = get_diff_colors()
    assert expected_add_bg_fragment in str(colors.add_bg)


def test_all_getters_respond_to_theme_switch():
    """Every color getter returns a different result after switching."""
    dark_diff = get_diff_colors()
    dark_toolbar = get_toolbar_colors()
    dark_mcp = get_mcp_prompt_colors()

    set_active_theme("light")

    assert get_diff_colors() != dark_diff
    assert get_toolbar_colors() != dark_toolbar
    assert get_mcp_prompt_colors() != dark_mcp


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_ptk_styles_valid_for_both_themes(theme: str):
    """get_prompt_style and get_task_browser_style return valid PTKStyle objects."""
    set_active_theme(theme)  # type: ignore[arg-type]
    prompt_style = get_prompt_style()
    browser_style = get_task_browser_style()
    assert prompt_style is not None
    assert browser_style is not None


# ---------------------------------------------------------------------------
# /theme slash command
# ---------------------------------------------------------------------------


def test_theme_command_registered_in_both_registries():
    from kimi_cli.ui.shell.slash import registry, shell_mode_registry

    agent_cmds = {c.name for c in registry.list_commands()}
    shell_cmds = {c.name for c in shell_mode_registry.list_commands()}
    assert "theme" in agent_cmds
    assert "theme" in shell_cmds


def test_theme_no_args_shows_current(runtime: Runtime, tmp_path: Path, monkeypatch):
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    shell_slash.theme(cast(Shell, app), "")

    assert print_mock.call_count == 2
    assert "dark" in str(print_mock.call_args_list[0].args[0])


def test_theme_invalid_arg(runtime: Runtime, tmp_path: Path, monkeypatch):
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    shell_slash.theme(cast(Shell, app), "neon")

    assert "Unknown theme" in str(print_mock.call_args.args[0])


def test_theme_same_as_current(runtime: Runtime, tmp_path: Path, monkeypatch):
    app = _make_shell_app(runtime, tmp_path)
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    shell_slash.theme(cast(Shell, app), "dark")

    assert "Already using" in str(print_mock.call_args.args[0])


def test_theme_switch_persists_and_reloads(runtime: Runtime, tmp_path: Path, monkeypatch):
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    config_for_save = get_default_config()
    load_mock = Mock(return_value=config_for_save)
    save_mock = Mock()
    monkeypatch.setattr(shell_slash, "load_config", load_mock)
    monkeypatch.setattr(shell_slash, "save_config", save_mock)
    monkeypatch.setattr(shell_slash.console, "print", Mock())

    with pytest.raises(Reload) as exc_info:
        shell_slash.theme(cast(Shell, app), "light")

    load_mock.assert_called_once_with(config_path)
    save_mock.assert_called_once()
    assert config_for_save.theme == "light"
    assert exc_info.value.session_id == runtime.session.id


def test_theme_switch_light_to_dark(runtime: Runtime, tmp_path: Path, monkeypatch):
    """Reverse direction: light → dark also works."""
    set_active_theme("light")
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    config_for_save = get_default_config()
    config_for_save.theme = "light"
    load_mock = Mock(return_value=config_for_save)
    save_mock = Mock()
    monkeypatch.setattr(shell_slash, "load_config", load_mock)
    monkeypatch.setattr(shell_slash, "save_config", save_mock)
    monkeypatch.setattr(shell_slash.console, "print", Mock())

    with pytest.raises(Reload):
        shell_slash.theme(cast(Shell, app), "dark")

    assert config_for_save.theme == "dark"


def test_theme_arg_case_and_whitespace(runtime: Runtime, tmp_path: Path, monkeypatch):
    """Args are stripped and lowercased: ' LIGHT ' should work."""
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    app = _make_shell_app(runtime, tmp_path)

    config_for_save = get_default_config()
    monkeypatch.setattr(shell_slash, "load_config", Mock(return_value=config_for_save))
    monkeypatch.setattr(shell_slash, "save_config", Mock())
    monkeypatch.setattr(shell_slash.console, "print", Mock())

    with pytest.raises(Reload):
        shell_slash.theme(cast(Shell, app), "  LIGHT  ")

    assert config_for_save.theme == "light"


def test_theme_rejects_inline_config(runtime: Runtime, tmp_path: Path, monkeypatch):
    runtime.config.source_file = None
    app = _make_shell_app(runtime, tmp_path)

    load_mock = Mock()
    save_mock = Mock()
    print_mock = Mock()
    monkeypatch.setattr(shell_slash, "load_config", load_mock)
    monkeypatch.setattr(shell_slash, "save_config", save_mock)
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    shell_slash.theme(cast(Shell, app), "light")

    load_mock.assert_not_called()
    save_mock.assert_not_called()
    assert "config file" in str(print_mock.call_args.args[0]).lower()


def test_theme_save_failure_no_reload_no_state_change(
    runtime: Runtime, tmp_path: Path, monkeypatch
):
    """When save fails: no Reload raised, global theme and config unchanged."""
    config_path = (tmp_path / "config.toml").resolve()
    runtime.config.source_file = config_path
    runtime.config.theme = "dark"
    app = _make_shell_app(runtime, tmp_path)

    monkeypatch.setattr(shell_slash, "load_config", Mock(side_effect=ConfigError("disk full")))
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    # Should NOT raise Reload
    shell_slash.theme(cast(Shell, app), "light")

    assert "Failed to save" in str(print_mock.call_args.args[0])
    assert get_active_theme() == "dark"
    assert runtime.config.theme == "dark"


# ---------------------------------------------------------------------------
# Config: theme field
# ---------------------------------------------------------------------------


def test_config_theme_defaults_and_validation():
    assert Config().theme == "dark"
    assert Config(theme="light").theme == "light"

    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Config(theme="neon")  # type: ignore[arg-type]


def test_config_theme_round_trip():
    data = Config(theme="light").model_dump()
    assert data["theme"] == "light"
    assert Config.model_validate(data).theme == "light"


# ---------------------------------------------------------------------------
# Shell startup initializes theme from config
# ---------------------------------------------------------------------------


async def test_shell_startup_initializes_theme_from_config(
    runtime: Runtime, tmp_path: Path, monkeypatch
):
    """Shell.run() should call set_active_theme with config.theme."""
    runtime.config.theme = "light"

    from kimi_cli.ui import theme as theme_mod
    from kimi_cli.ui.shell import Shell as RealShell

    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = RealShell(soul)

    set_theme_mock = Mock(side_effect=set_active_theme)
    monkeypatch.setattr(theme_mod, "set_active_theme", set_theme_mock)

    # Shell.run(command=...) initializes theme then runs the command.
    # The command will fail (no LLM), but theme init happens first.
    await shell.run(command="hello")

    set_theme_mock.assert_called_with("light")


# ---------------------------------------------------------------------------
# Diff rendering respects theme
# ---------------------------------------------------------------------------


def test_render_diff_panel_both_themes():
    from rich.console import Console

    from kimi_cli.utils.rich.diff_render import (
        DiffLine,
        DiffLineKind,
        render_diff_panel,
    )

    hunk = [
        DiffLine(kind=DiffLineKind.ADD, old_num=0, new_num=1, code="added line"),
        DiffLine(kind=DiffLineKind.DELETE, old_num=1, new_num=0, code="deleted line"),
    ]

    for theme_name in ("dark", "light"):
        set_active_theme(theme_name)  # type: ignore[arg-type]
        panel = render_diff_panel("test.py", [hunk], added=1, removed=1)
        console = Console(width=80, force_terminal=True, color_system=None)
        with console.capture() as cap:
            console.print(panel, end="")
        output = cap.get()
        assert "added line" in output
        assert "deleted line" in output

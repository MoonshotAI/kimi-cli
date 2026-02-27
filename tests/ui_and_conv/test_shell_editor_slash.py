from __future__ import annotations

from collections.abc import Awaitable
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import Mock

from kosong.tooling.empty import EmptyToolset

from kimi_cli.config import get_default_config
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


async def test_editor_persists_to_runtime_config_file(
    runtime: Runtime, tmp_path: Path, monkeypatch
) -> None:
    config_path = (tmp_path / "custom-config.toml").resolve()
    runtime.config.source_file = config_path
    runtime.config.is_from_default_location = False
    runtime.config.default_editor = ""

    app = _make_shell_app(runtime, tmp_path)

    config_for_save = get_default_config()
    load_mock = Mock(return_value=config_for_save)
    save_mock = Mock()
    monkeypatch.setattr(shell_slash, "load_config", load_mock)
    monkeypatch.setattr(shell_slash, "save_config", save_mock)
    monkeypatch.setattr("shutil.which", lambda _binary: "/usr/bin/vim")

    ret = shell_slash.editor(cast(Shell, app), "vim")
    if isinstance(ret, Awaitable):
        await ret

    load_mock.assert_called_once_with(config_path)
    save_mock.assert_called_once_with(config_for_save, config_path)
    assert config_for_save.default_editor == "vim"
    assert runtime.config.default_editor == "vim"


async def test_editor_rejects_inline_config_without_source_file(
    runtime: Runtime, tmp_path: Path, monkeypatch
) -> None:
    runtime.config.source_file = None
    runtime.config.default_editor = ""
    app = _make_shell_app(runtime, tmp_path)

    load_mock = Mock()
    save_mock = Mock()
    print_mock = Mock()
    monkeypatch.setattr(shell_slash, "load_config", load_mock)
    monkeypatch.setattr(shell_slash, "save_config", save_mock)
    monkeypatch.setattr(shell_slash.console, "print", print_mock)

    ret = shell_slash.editor(cast(Shell, app), "vim")
    if isinstance(ret, Awaitable):
        await ret

    load_mock.assert_not_called()
    save_mock.assert_not_called()
    assert runtime.config.default_editor == ""
    assert print_mock.called
    assert "inline --config" in str(print_mock.call_args.args[0])

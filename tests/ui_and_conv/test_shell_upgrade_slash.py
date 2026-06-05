"""Tests for the /upgrade shell slash command."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from kimi_cli.ui.shell import slash as shell_slash
from kimi_cli.ui.shell.slash import registry as shell_slash_registry

UPGRADE = shell_slash_registry.find_command("upgrade")
INSTALL_SH = "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"


def _mock_choice(monkeypatch, value: str):
    monkeypatch.setattr(
        "prompt_toolkit.shortcuts.choice_input.ChoiceInput.prompt_async",
        AsyncMock(return_value=value),
    )


@pytest.mark.asyncio
async def test_upgrade_command_registered():
    assert UPGRADE is not None


@pytest.mark.asyncio
async def test_upgrade_yes_runs_installer(monkeypatch):
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)
    monkeypatch.setattr(shell_slash, "sys", SimpleNamespace(platform="darwin"))
    _mock_choice(monkeypatch, "yes")
    app = SimpleNamespace(_run_shell_command=AsyncMock())

    await UPGRADE.func(app, "")

    app._run_shell_command.assert_awaited_once_with(INSTALL_SH)


@pytest.mark.asyncio
async def test_upgrade_no_does_not_run_installer(monkeypatch):
    print_mock = Mock()
    monkeypatch.setattr(shell_slash.console, "print", print_mock)
    monkeypatch.setattr(shell_slash, "sys", SimpleNamespace(platform="darwin"))
    _mock_choice(monkeypatch, "no")
    app = SimpleNamespace(_run_shell_command=AsyncMock())

    await UPGRADE.func(app, "")

    app._run_shell_command.assert_not_awaited()
    printed = " ".join(str(c.args[0]) for c in print_mock.call_args_list if c.args)
    assert INSTALL_SH in printed

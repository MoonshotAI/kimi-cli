from __future__ import annotations

from types import SimpleNamespace
from typing import cast
from unittest.mock import MagicMock

import pytest
from kosong.chat_provider import APIStatusError

import kimi_cli.ui.shell as shell_module
from kimi_cli.soul import Soul


def _make_fake_soul():
    return SimpleNamespace(
        name="Test Soul",
        available_slash_commands=[],
        model_capabilities=set(),
        model_name=None,
        thinking=False,
        status=SimpleNamespace(context_usage=0.0, context_tokens=0, max_context_tokens=0),
    )


@pytest.mark.asyncio
async def test_shell_run_soul_command_shows_friendly_rate_limit_message(monkeypatch) -> None:
    shell = shell_module.Shell(cast(Soul, _make_fake_soul()))
    printed: list[str] = []
    warning = MagicMock()
    exception = MagicMock()

    async def _raise(*args, **kwargs):
        raise APIStatusError(
            429,
            "You've reached your usage limit for this period. "
            "Your quota will be refreshed in the next period.",
        )

    monkeypatch.setattr(shell_module, "run_soul", _raise)
    monkeypatch.setattr(
        shell_module, "install_sigint_handler", lambda *args, **kwargs: lambda: None
    )
    monkeypatch.setattr(
        shell_module.console,
        "print",
        lambda text="": printed.append(getattr(text, "plain", str(text))),
    )
    monkeypatch.setattr(shell_module.logger, "warning", warning)
    monkeypatch.setattr(shell_module.logger, "exception", exception)

    ok = await shell.run_soul_command("hello")

    assert ok is False
    assert printed == [
        "[yellow]Usage limit reached for this period.[/yellow]\n"
        "[dim]Wait for quota refresh or upgrade your plan.[/dim]\n"
        "[dim]Server: You've reached your usage limit for this period. "
        "Your quota will be refreshed in the next period.[/dim]"
    ]
    warning.assert_called_once()
    exception.assert_not_called()

from __future__ import annotations

import pytest
import typer

from kimi_cli.cli import toad


def test_default_toad_command_exits_cleanly_on_windows(monkeypatch, capsys) -> None:
    monkeypatch.setattr(toad.sys, "platform", "win32")
    monkeypatch.setattr(toad.sys, "version_info", (3, 14, 0))

    def fail_find_spec(name: str) -> None:
        raise AssertionError(f"find_spec should not be called for {name}")

    monkeypatch.setattr(toad.importlib.util, "find_spec", fail_find_spec)

    with pytest.raises(typer.Exit) as exc_info:
        toad._default_toad_command()

    assert exc_info.value.exit_code == 1
    assert "`kimi term` is not supported on Windows yet" in capsys.readouterr().err

from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

from kimi_cli.ui.shell.migration_nudge import print_migration_goodbye


def _printed(console: Mock) -> str:
    return " ".join(str(c.args[0]) for c in console.print.call_args_list if c.args)


def test_goodbye_shows_nudge_when_not_installed(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("kimi_cli.ui.shell.migration_nudge.get_share_dir", lambda: tmp_path)
    console = Mock()
    print_migration_goodbye(console, home=tmp_path, today="2026-06-05")
    # "Bye!" plus the migration tip = 2 prints
    assert console.print.call_count == 2
    assert "Bye!" in _printed(console)

    # same day -> throttled, only "Bye!"
    console.print.reset_mock()
    print_migration_goodbye(console, home=tmp_path, today="2026-06-05")
    assert console.print.call_count == 1
    assert "Bye!" in _printed(console)


def test_goodbye_skips_nudge_when_installed(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("kimi_cli.ui.shell.migration_nudge.get_share_dir", lambda: tmp_path)
    (tmp_path / ".kimi-code").mkdir()
    console = Mock()
    print_migration_goodbye(console, home=tmp_path, today="2026-06-05")
    # installed -> no nudge, only "Bye!"
    assert console.print.call_count == 1
    assert "Bye!" in _printed(console)


def test_goodbye_nudge_uses_platform_install_command(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("kimi_cli.ui.shell.migration_nudge.get_share_dir", lambda: tmp_path)
    console = Mock()
    print_migration_goodbye(console, home=tmp_path, today="2026-06-05", platform="win32")
    assert "install.ps1 | iex" in _printed(console)

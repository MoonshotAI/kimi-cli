from __future__ import annotations

from pathlib import Path

from kimi_cli.ui.shell import migration_nudge as mn


def test_install_command_per_platform():
    assert mn.install_command("darwin") == (
        "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
    )
    assert mn.install_command("linux") == (
        "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
    )
    assert mn.install_command("win32") == ("irm https://code.kimi.com/kimi-code/install.ps1 | iex")


def test_kimi_code_installed_detects_dir(tmp_path: Path):
    assert mn.kimi_code_installed(tmp_path) is False
    (tmp_path / ".kimi-code").mkdir()
    assert mn.kimi_code_installed(tmp_path) is True


def test_exit_nudge_throttled_once_per_day(tmp_path: Path):
    marker = mn.exit_nudge_marker(tmp_path)
    assert mn.should_show_exit_nudge(marker, "2026-06-05") is True
    assert mn.should_show_exit_nudge(marker, "2026-06-05") is False
    assert mn.should_show_exit_nudge(marker, "2026-06-06") is True

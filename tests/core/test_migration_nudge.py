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


def test_install_run_command_wraps_powershell_on_windows():
    # Non-Windows runs the bash installer directly.
    assert mn.install_run_command("darwin") == mn.install_command("darwin")
    assert mn.install_run_command("linux") == mn.install_command("linux")
    # Windows must wrap the PowerShell one-liner so it doesn't run under cmd.exe.
    win = mn.install_run_command("win32")
    assert win.startswith("powershell ")
    assert "irm https://code.kimi.com/kimi-code/install.ps1 | iex" in win


def test_verify_command_per_platform():
    assert mn.verify_command("darwin") == "which kimi"
    assert mn.verify_command("linux") == "which kimi"
    assert mn.verify_command("win32") == "where kimi"


def test_exit_nudge_text_uses_platform_install_command():
    assert "curl -fsSL" in mn.exit_nudge_text("linux").plain
    assert (
        "irm https://code.kimi.com/kimi-code/install.ps1 | iex" in mn.exit_nudge_text("win32").plain
    )


def test_kimi_code_installed_detects_dir(tmp_path: Path):
    assert mn.kimi_code_installed(tmp_path) is False
    (tmp_path / ".kimi-code").mkdir()
    assert mn.kimi_code_installed(tmp_path) is True


def test_exit_nudge_throttled_once_per_day(tmp_path: Path):
    marker = mn.exit_nudge_marker(tmp_path)
    assert mn.should_show_exit_nudge(marker, "2026-06-05") is True
    assert mn.should_show_exit_nudge(marker, "2026-06-05") is False
    assert mn.should_show_exit_nudge(marker, "2026-06-06") is True

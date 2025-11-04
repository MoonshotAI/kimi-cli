from unittest.mock import MagicMock

from kimi_cli.soul import Soul
from kimi_cli.ui.shell import ShellApp


def _build_shell_app(tmp_path):
    app = ShellApp(soul=MagicMock(spec=Soul))
    app._shell_cwd = tmp_path
    app._previous_shell_cwd = None
    return app


def test_cd_changes_relative_directory(tmp_path):
    shell_app = _build_shell_app(tmp_path)
    target = tmp_path / "child"
    target.mkdir()

    handled = shell_app._handle_cd_command("cd child")

    assert handled is True
    assert shell_app._shell_cwd == target.resolve()


def test_cd_dash_swaps_with_previous_directory(tmp_path):
    shell_app = _build_shell_app(tmp_path)
    second = tmp_path / "second"
    second.mkdir()

    shell_app._handle_cd_command(f"cd {second}")
    result = shell_app._handle_cd_command("cd -")

    assert result is True
    assert shell_app._shell_cwd == tmp_path.resolve()
    assert shell_app._previous_shell_cwd == second.resolve()


def test_cd_nonexistent_directory_keeps_current(tmp_path):
    shell_app = _build_shell_app(tmp_path)
    previous = shell_app._shell_cwd

    shell_app._handle_cd_command("cd missing-dir")

    assert shell_app._shell_cwd == previous

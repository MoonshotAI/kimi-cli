from __future__ import annotations

import sys
from unittest.mock import MagicMock

import pytest

from kimi_cli.ui.shell.update import semver_tuple


# ---------------------------------------------------------------------------
# TestCheckUpdateGate
# ---------------------------------------------------------------------------
class TestCheckUpdateGate:
    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path, monkeypatch):
        self.latest_file = tmp_path / "latest_version.txt"
        self.skipped_file = tmp_path / "skipped_version.txt"

        monkeypatch.setattr("kimi_cli.ui.shell.update.LATEST_VERSION_FILE", self.latest_file)
        monkeypatch.setattr("kimi_cli.ui.shell.update.SKIPPED_VERSION_FILE", self.skipped_file)
        monkeypatch.setattr("kimi_cli.constant.VERSION", "1.2.3")

        # Ensure stdin.isatty() returns True by default
        monkeypatch.setattr("sys.stdin", MagicMock(isatty=MagicMock(return_value=True)))

        # Ensure stdout.isatty() returns True — patch the existing object's method
        # rather than replacing stdout (which conflicts with pytest's capture)
        self._orig_stdout_isatty = sys.stdout.isatty if hasattr(sys.stdout, "isatty") else None
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)

        self._run_gate_mock = MagicMock()
        monkeypatch.setattr("kimi_cli.ui.shell.update._run_update_gate", self._run_gate_mock)

    def test_skips_when_auto_update_disabled(self, monkeypatch):
        from kimi_cli.ui.shell.update import check_update_gate

        self.latest_file.write_text("2.0.0")
        monkeypatch.setenv("KIMI_CLI_NO_AUTO_UPDATE", "1")
        check_update_gate()
        self._run_gate_mock.assert_not_called()

    def test_skips_when_stdin_not_tty(self, monkeypatch):
        from kimi_cli.ui.shell.update import check_update_gate

        self.latest_file.write_text("2.0.0")
        monkeypatch.setattr("sys.stdin", MagicMock(isatty=MagicMock(return_value=False)))
        check_update_gate()
        self._run_gate_mock.assert_not_called()

    def test_skips_when_stdout_not_tty(self, monkeypatch):
        from kimi_cli.ui.shell.update import check_update_gate

        self.latest_file.write_text("2.0.0")
        monkeypatch.setattr("sys.stdout", MagicMock(isatty=MagicMock(return_value=False)))
        check_update_gate()
        self._run_gate_mock.assert_not_called()

    def test_skips_when_no_version_file(self):
        from kimi_cli.ui.shell.update import check_update_gate

        check_update_gate()
        self._run_gate_mock.assert_not_called()

    def test_skips_when_up_to_date(self):
        from kimi_cli.ui.shell.update import check_update_gate

        self.latest_file.write_text("1.2.3")
        check_update_gate()
        self._run_gate_mock.assert_not_called()

    def test_skips_when_older_version(self):
        from kimi_cli.ui.shell.update import check_update_gate

        self.latest_file.write_text("1.0.0")
        check_update_gate()
        self._run_gate_mock.assert_not_called()

    def test_triggers_when_newer_version(self):
        from kimi_cli.ui.shell.update import check_update_gate

        self.latest_file.write_text("1.5.0")
        check_update_gate()
        self._run_gate_mock.assert_called_once_with("1.2.3", "1.5.0")

    def test_skips_when_version_is_skipped(self):
        from kimi_cli.ui.shell.update import check_update_gate

        self.latest_file.write_text("1.5.0")
        self.skipped_file.write_text("1.5.0")
        check_update_gate()
        self._run_gate_mock.assert_not_called()

    def test_triggers_when_older_version_skipped(self):
        from kimi_cli.ui.shell.update import check_update_gate

        self.latest_file.write_text("1.5.0")
        self.skipped_file.write_text("1.3.0")
        check_update_gate()
        self._run_gate_mock.assert_called_once_with("1.2.3", "1.5.0")

    def test_skips_when_latest_file_unreadable(self, monkeypatch):
        from kimi_cli.ui.shell.update import check_update_gate

        self.latest_file.write_text("2.0.0")
        monkeypatch.setattr(
            "kimi_cli.ui.shell.update.LATEST_VERSION_FILE",
            MagicMock(
                exists=MagicMock(return_value=True), read_text=MagicMock(side_effect=OSError)
            ),
        )
        check_update_gate()
        self._run_gate_mock.assert_not_called()

    def test_triggers_when_skipped_file_unreadable(self, monkeypatch):
        from kimi_cli.ui.shell.update import check_update_gate

        self.latest_file.write_text("2.0.0")
        self.skipped_file.write_text("2.0.0")
        monkeypatch.setattr(
            "kimi_cli.ui.shell.update.SKIPPED_VERSION_FILE",
            MagicMock(
                exists=MagicMock(return_value=True), read_text=MagicMock(side_effect=OSError)
            ),
        )
        check_update_gate()
        self._run_gate_mock.assert_called_once_with("1.2.3", "2.0.0")


# ---------------------------------------------------------------------------
# Semver edge cases
# ---------------------------------------------------------------------------
class TestSemverEdgeCases:
    def test_minor_boundary(self):
        assert semver_tuple("1.0.9") < semver_tuple("1.1.0")

    def test_major_boundary(self):
        assert semver_tuple("0.99.0") < semver_tuple("1.0.0")

    def test_v_prefix(self):
        assert semver_tuple("v1.2.3") == (1, 2, 3)


# ---------------------------------------------------------------------------
# TestRunUpdateGate
# ---------------------------------------------------------------------------
class TestRunUpdateGate:
    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path, monkeypatch):
        self.skipped_file = tmp_path / "skipped_version.txt"
        monkeypatch.setattr("kimi_cli.ui.shell.update.SKIPPED_VERSION_FILE", self.skipped_file)
        # Silence rich output
        monkeypatch.setattr("kimi_cli.ui.shell.update.console", MagicMock())

    def test_enter_cr_runs_upgrade_and_exits_zero(self, monkeypatch):
        from kimi_cli.ui.shell.update import _run_update_gate

        monkeypatch.setattr("kimi_cli.ui.shell.update._read_key", lambda: "\r")
        mock_run = MagicMock(return_value=MagicMock(returncode=0))
        monkeypatch.setattr("subprocess.run", mock_run)

        with pytest.raises(SystemExit) as exc_info:
            _run_update_gate("1.2.3", "1.5.0")
        assert exc_info.value.code == 0
        mock_run.assert_called_once_with(["uv", "tool", "upgrade", "kimi-cli"])

    def test_enter_lf_runs_upgrade_and_exits_zero(self, monkeypatch):
        from kimi_cli.ui.shell.update import _run_update_gate

        monkeypatch.setattr("kimi_cli.ui.shell.update._read_key", lambda: "\n")
        mock_run = MagicMock(return_value=MagicMock(returncode=0))
        monkeypatch.setattr("subprocess.run", mock_run)

        with pytest.raises(SystemExit) as exc_info:
            _run_update_gate("1.2.3", "1.5.0")
        assert exc_info.value.code == 0

    def test_enter_upgrade_fails_exits_nonzero(self, monkeypatch):
        from kimi_cli.ui.shell.update import _run_update_gate

        monkeypatch.setattr("kimi_cli.ui.shell.update._read_key", lambda: "\r")
        mock_run = MagicMock(return_value=MagicMock(returncode=1))
        monkeypatch.setattr("subprocess.run", mock_run)

        with pytest.raises(SystemExit) as exc_info:
            _run_update_gate("1.2.3", "1.5.0")
        assert exc_info.value.code == 1

    def test_enter_upgrade_command_not_found(self, monkeypatch):
        from kimi_cli.ui.shell.update import _run_update_gate

        monkeypatch.setattr("kimi_cli.ui.shell.update._read_key", lambda: "\r")
        monkeypatch.setattr("subprocess.run", MagicMock(side_effect=OSError("No such file")))

        with pytest.raises(SystemExit) as exc_info:
            _run_update_gate("1.2.3", "1.5.0")
        assert exc_info.value.code == 1

    def test_s_writes_skip_file_and_continues(self, monkeypatch):
        from kimi_cli.ui.shell.update import _run_update_gate

        monkeypatch.setattr("kimi_cli.ui.shell.update._read_key", lambda: "s")
        _run_update_gate("1.2.3", "1.5.0")
        assert self.skipped_file.read_text(encoding="utf-8") == "1.5.0"

    def test_S_writes_skip_file_and_continues(self, monkeypatch):
        from kimi_cli.ui.shell.update import _run_update_gate

        monkeypatch.setattr("kimi_cli.ui.shell.update._read_key", lambda: "S")
        _run_update_gate("1.2.3", "1.5.0")
        assert self.skipped_file.read_text(encoding="utf-8") == "1.5.0"

    def test_s_continues_even_when_skip_file_write_fails(self, monkeypatch):
        from kimi_cli.ui.shell.update import _run_update_gate

        monkeypatch.setattr("kimi_cli.ui.shell.update._read_key", lambda: "s")
        monkeypatch.setattr(
            "kimi_cli.ui.shell.update.SKIPPED_VERSION_FILE",
            MagicMock(write_text=MagicMock(side_effect=OSError)),
        )
        _run_update_gate("1.2.3", "1.5.0")

    def test_q_continues_without_action(self, monkeypatch):
        from kimi_cli.ui.shell.update import _run_update_gate

        monkeypatch.setattr("kimi_cli.ui.shell.update._read_key", lambda: "q")
        mock_run = MagicMock()
        monkeypatch.setattr("subprocess.run", mock_run)
        _run_update_gate("1.2.3", "1.5.0")
        assert not self.skipped_file.exists()
        mock_run.assert_not_called()

    def test_ctrl_c_exits_cleanly(self, monkeypatch):
        from kimi_cli.ui.shell.update import _run_update_gate

        monkeypatch.setattr("kimi_cli.ui.shell.update._read_key", lambda: "\x03")
        with pytest.raises(SystemExit) as exc_info:
            _run_update_gate("1.2.3", "1.5.0")
        assert exc_info.value.code == 0

    def test_esc_exits_cleanly(self, monkeypatch):
        from kimi_cli.ui.shell.update import _run_update_gate

        monkeypatch.setattr("kimi_cli.ui.shell.update._read_key", lambda: "\x1b")
        with pytest.raises(SystemExit) as exc_info:
            _run_update_gate("1.2.3", "1.5.0")
        assert exc_info.value.code == 0

    def test_unknown_key_continues(self, monkeypatch):
        from kimi_cli.ui.shell.update import _run_update_gate

        monkeypatch.setattr("kimi_cli.ui.shell.update._read_key", lambda: "x")
        mock_run = MagicMock()
        monkeypatch.setattr("subprocess.run", mock_run)
        _run_update_gate("1.2.3", "1.5.0")
        assert not self.skipped_file.exists()
        mock_run.assert_not_called()


# ---------------------------------------------------------------------------
# TestReadKeyWindows
# ---------------------------------------------------------------------------
class TestReadKeyWindows:
    def test_win32_uses_msvcrt(self, monkeypatch):
        monkeypatch.setattr("sys.platform", "win32")
        mock_msvcrt = MagicMock()
        mock_msvcrt.getwch.return_value = "q"
        monkeypatch.setitem(__import__("sys").modules, "msvcrt", mock_msvcrt)

        from kimi_cli.ui.shell.update import _read_key

        result = _read_key()
        assert result == "q"
        mock_msvcrt.getwch.assert_called_once()


# ---------------------------------------------------------------------------
# TestAutoUpdateNoToast
# ---------------------------------------------------------------------------
class TestAutoUpdateNoToast:
    @pytest.fixture()
    def mock_self(self):
        return MagicMock()

    @pytest.mark.asyncio
    async def test_update_available_produces_no_toast(self, monkeypatch, mock_self):
        from kimi_cli.ui.shell import Shell

        async def fake_do_update(*, print, check_only):
            from kimi_cli.ui.shell.update import UpdateResult

            return UpdateResult.UPDATE_AVAILABLE

        monkeypatch.setattr("kimi_cli.ui.shell.do_update", fake_do_update)
        mock_toast = MagicMock()
        monkeypatch.setattr("kimi_cli.ui.shell.toast", mock_toast)

        await Shell._auto_update(mock_self)
        mock_toast.assert_not_called()

    @pytest.mark.asyncio
    async def test_updated_still_shows_toast(self, monkeypatch, mock_self):
        from kimi_cli.ui.shell import Shell

        async def fake_do_update(*, print, check_only):
            from kimi_cli.ui.shell.update import UpdateResult

            return UpdateResult.UPDATED

        monkeypatch.setattr("kimi_cli.ui.shell.do_update", fake_do_update)
        mock_toast = MagicMock()
        monkeypatch.setattr("kimi_cli.ui.shell.toast", mock_toast)

        await Shell._auto_update(mock_self)
        mock_toast.assert_called_once()
        assert "restart" in mock_toast.call_args[0][0]

    @pytest.mark.asyncio
    async def test_up_to_date_no_toast(self, monkeypatch, mock_self):
        from kimi_cli.ui.shell import Shell

        async def fake_do_update(*, print, check_only):
            from kimi_cli.ui.shell.update import UpdateResult

            return UpdateResult.UP_TO_DATE

        monkeypatch.setattr("kimi_cli.ui.shell.do_update", fake_do_update)
        mock_toast = MagicMock()
        monkeypatch.setattr("kimi_cli.ui.shell.toast", mock_toast)

        await Shell._auto_update(mock_self)
        mock_toast.assert_not_called()


# ---------------------------------------------------------------------------
# TestPrintWelcomeInfoSkipsVersion
# ---------------------------------------------------------------------------
class TestPrintWelcomeInfoSkipsVersion:
    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path, monkeypatch):
        self.latest_file = tmp_path / "latest_version.txt"
        self.skipped_file = tmp_path / "skipped_version.txt"

        monkeypatch.setattr("kimi_cli.ui.shell.LATEST_VERSION_FILE", self.latest_file)
        monkeypatch.setattr("kimi_cli.ui.shell.update.SKIPPED_VERSION_FILE", self.skipped_file)
        monkeypatch.setattr("kimi_cli.constant.VERSION", "1.2.3")
        monkeypatch.setattr("kimi_cli.ui.shell.console", MagicMock())

    @staticmethod
    def _extract_panel_text(mock_console) -> str:
        """Extract plain text from the Panel's Group renderable."""
        from rich.text import Text

        panel = mock_console.print.call_args[0][0]
        group = panel.renderable
        texts = []
        for item in group.renderables:
            if isinstance(item, Text):
                texts.append(item.plain)
        return "\n".join(texts)

    def test_welcome_shows_update_when_not_skipped(self, monkeypatch):
        from kimi_cli.ui.shell import _print_welcome_info

        self.latest_file.write_text("2.0.0")
        mock_console = MagicMock()
        monkeypatch.setattr("kimi_cli.ui.shell.console", mock_console)

        _print_welcome_info("test", [])

        rendered = self._extract_panel_text(mock_console)
        assert "New version available" in rendered

    def test_welcome_hides_update_when_skipped(self, monkeypatch):
        from kimi_cli.ui.shell import _print_welcome_info

        self.latest_file.write_text("2.0.0")
        self.skipped_file.write_text("2.0.0")
        mock_console = MagicMock()
        monkeypatch.setattr("kimi_cli.ui.shell.console", mock_console)

        _print_welcome_info("test", [])

        rendered = self._extract_panel_text(mock_console)
        assert "New version available" not in rendered

    def test_welcome_shows_update_when_different_version_skipped(self, monkeypatch):
        from kimi_cli.ui.shell import _print_welcome_info

        self.latest_file.write_text("2.0.0")
        self.skipped_file.write_text("1.5.0")
        mock_console = MagicMock()
        monkeypatch.setattr("kimi_cli.ui.shell.console", mock_console)

        _print_welcome_info("test", [])

        rendered = self._extract_panel_text(mock_console)
        assert "New version available" in rendered

    def test_welcome_hides_update_when_auto_update_disabled(self, monkeypatch):
        from kimi_cli.ui.shell import _print_welcome_info

        self.latest_file.write_text("2.0.0")
        monkeypatch.setenv("KIMI_CLI_NO_AUTO_UPDATE", "1")
        mock_console = MagicMock()
        monkeypatch.setattr("kimi_cli.ui.shell.console", mock_console)

        _print_welcome_info("test", [])

        rendered = self._extract_panel_text(mock_console)
        assert "New version available" not in rendered

    def test_welcome_no_crash_when_latest_file_unreadable(self, monkeypatch):
        from kimi_cli.ui.shell import _print_welcome_info

        monkeypatch.setattr(
            "kimi_cli.ui.shell.LATEST_VERSION_FILE",
            MagicMock(
                exists=MagicMock(return_value=True), read_text=MagicMock(side_effect=OSError)
            ),
        )
        mock_console = MagicMock()
        monkeypatch.setattr("kimi_cli.ui.shell.console", mock_console)

        _print_welcome_info("test", [])

        rendered = self._extract_panel_text(mock_console)
        assert "New version available" not in rendered

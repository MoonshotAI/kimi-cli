"""Tests for meta command functionality using inline-snapshot."""

import sys
from typing import Any
from unittest.mock import patch

import pytest
from inline_snapshot import snapshot

from kimi_cli.ui.shell.metacmd import _meta_command_aliases, _meta_commands, meta_command


def check_meta_commands(snapshot: Any):
    """Usage: check_meta_commands(snapshot()), then `uv run pytest` will update the snapshot."""

    import json

    pretty_meta_commands = json.dumps(
        {
            alias: f"{cmd.slash_name()}: {cmd.description}"
            for (alias, cmd) in _meta_command_aliases.items()
        },
        indent=2,
        sort_keys=True,
    )
    assert pretty_meta_commands == snapshot


@pytest.fixture(autouse=True)
def clear_meta_commands():
    """Clear meta commands before and after each test."""
    original = _meta_commands.copy()
    original_aliases = _meta_command_aliases.copy()
    _meta_commands.clear()
    _meta_command_aliases.clear()
    yield
    _meta_commands.clear()
    _meta_commands.update(original)
    _meta_command_aliases.clear()
    _meta_command_aliases.update(original_aliases)


def test_meta_command_registration():
    """Test all meta command registration scenarios."""

    # Basic registration
    @meta_command
    def basic(app, args):
        """Basic command."""
        pass

    # Custom name, original name should be ignored
    @meta_command(name="run")
    def start(app, args):
        """Run something."""
        pass

    # Aliases only, original name should be kept
    @meta_command(aliases=["h", "?"])
    def help(app, args):
        """Show help."""
        pass

    # Custom name with aliases
    @meta_command(name="search", aliases=["s", "find"])
    def query(app, args):
        """Search items."""
        pass

    # Edge cases: no doc, whitespace doc, duplicate aliases
    @meta_command
    def no_doc(app, args):
        pass

    @meta_command
    def whitespace_doc(app, args):
        """\n\t"""
        pass

    @meta_command(aliases=["dup", "dup"])
    def dedup_test(app, args):
        """Test deduplication."""
        pass

    check_meta_commands(
        snapshot("""\
{
  "?": "/help (h, ?): Show help.",
  "basic": "/basic: Basic command.",
  "dedup_test": "/dedup_test (dup, dup): Test deduplication.",
  "dup": "/dedup_test (dup, dup): Test deduplication.",
  "find": "/search (s, find): Search items.",
  "h": "/help (h, ?): Show help.",
  "help": "/help (h, ?): Show help.",
  "no_doc": "/no_doc: ",
  "run": "/run: Run something.",
  "s": "/search (s, find): Search items.",
  "search": "/search (s, find): Search items.",
  "whitespace_doc": "/whitespace_doc: "
}\
""")
    )


def test_meta_command_overwriting():
    """Test command overwriting behavior."""

    @meta_command
    def test_cmd(app, args):
        """First version."""
        pass

    check_meta_commands(
        snapshot("""\
{
  "test_cmd": "/test_cmd: First version."
}\
""")
    )

    @meta_command(name="test_cmd")
    def _test_cmd(app, args):  # Same name, different function
        """Second version."""
        pass

    check_meta_commands(
        snapshot("""\
{
  "test_cmd": "/test_cmd: Second version."
}\
""")
    )


class TestSetupReloadCommands:
    """Test setup and reload commands behavior in different environments."""

    @patch("kimi_cli.ui.shell.setup.console")
    @patch("kimi_cli.ui.shell.setup.load_config")
    @patch("kimi_cli.ui.shell.setup.save_config")
    def test_setup_command_in_development_environment(
        self, mock_save_config, mock_load_config, mock_console
    ):
        """Test setup command in development environment (not frozen)."""
        from kimi_cli.cli import Reload
        from kimi_cli.ui.shell.setup import setup

        # Mock the setup flow
        mock_load_config.return_value.providers = {}
        mock_load_config.return_value.models = {}
        mock_load_config.return_value.services = type("services", (), {})()

        # Mock the async setup function
        with patch("kimi_cli.ui.shell.setup._setup") as mock_setup:
            mock_platform = type(
                "platform",
                (),
                {"id": "test", "base_url": "https://api.test.com", "search_url": None},
            )()
            mock_result = type(
                "result",
                (),
                {
                    "platform": mock_platform,
                    "api_key": "test_key",
                    "model_id": "test_model",
                    "max_context_size": 1000,
                },
            )()
            mock_setup.return_value = mock_result

            # Mock app
            from unittest.mock import MagicMock

            mock_app = MagicMock()

            # Test in development environment (not frozen)
            with patch.object(sys, "frozen", False, create=True), pytest.raises(Reload):
                import asyncio

                asyncio.run(setup(mock_app, []))  # type: ignore

            # Verify reload message was shown
            mock_console.print.assert_any_call(
                "[green]✓[/green] Kimi CLI has been setup! Reloading..."
            )

    @patch("kimi_cli.ui.shell.setup.console")
    @patch("kimi_cli.ui.shell.setup.load_config")
    @patch("kimi_cli.ui.shell.setup.save_config")
    def test_setup_command_in_frozen_environment(
        self, mock_save_config, mock_load_config, mock_console
    ):
        """Test setup command in PyInstaller frozen environment."""
        from kimi_cli.ui.shell.setup import setup

        # Mock the setup flow
        mock_load_config.return_value.providers = {}
        mock_load_config.return_value.models = {}
        mock_load_config.return_value.services = type("services", (), {})()

        # Mock the async setup function
        with patch("kimi_cli.ui.shell.setup._setup") as mock_setup:
            mock_platform = type(
                "platform",
                (),
                {"id": "test", "base_url": "https://api.test.com", "search_url": None},
            )()
            mock_result = type(
                "result",
                (),
                {
                    "platform": mock_platform,
                    "api_key": "test_key",
                    "model_id": "test_model",
                    "max_context_size": 1000,
                },
            )()
            mock_setup.return_value = mock_result

            # Mock app
            from unittest.mock import MagicMock

            mock_app = MagicMock()

            # Test in frozen environment
            with (
                patch.object(sys, "frozen", True, create=True),
                patch.object(sys, "_MEIPASS", "/fake/path", create=True),
                patch("kimi_cli.ui.shell.setup.wait_for_key_press") as mock_wait,
            ):
                import asyncio

                from kimi_cli.cli import Exit

                with pytest.raises(Exit) as exc_info:
                    asyncio.run(setup(mock_app, []))  # type: ignore

                # Should raise Exit exception with code 0
                assert exc_info.value.code == 0

                # Verify restart message was shown
                mock_console.print.assert_any_call("[green]✓[/green] Kimi CLI has been setup!")
                mock_console.print.assert_any_call(
                    "[yellow]Please restart Kimi CLI to apply the new configuration.[/yellow]"
                )

                # Verify wait_for_key_press was called
                mock_wait.assert_called_once_with("Press any key to exit...")

    @patch("kimi_cli.ui.shell.setup.console")
    def test_reload_command_in_development_environment(self, mock_console):
        """Test reload command in development environment."""
        from unittest.mock import MagicMock

        from kimi_cli.cli import Reload
        from kimi_cli.ui.shell.setup import reload

        mock_app = MagicMock()

        # Test in development environment
        with patch.object(sys, "frozen", False, create=True), pytest.raises(Reload):
            reload(mock_app, [])  # type: ignore

    @patch("kimi_cli.ui.shell.setup.console")
    def test_reload_command_in_frozen_environment(self, mock_console):
        """Test reload command in PyInstaller frozen environment."""
        from unittest.mock import MagicMock

        from kimi_cli.ui.shell.setup import reload

        mock_app = MagicMock()

        # Test in frozen environment
        with (
            patch.object(sys, "frozen", True, create=True),
            patch.object(sys, "_MEIPASS", "/fake/path", create=True),
            patch("kimi_cli.ui.shell.setup.wait_for_key_press") as mock_wait,
        ):
            from kimi_cli.cli import Exit

            with pytest.raises(Exit) as exc_info:
                reload(mock_app, [])  # type: ignore

            # Should raise Exit exception with code 0
            assert exc_info.value.code == 0

            # Verify warning message was shown
            mock_console.print.assert_any_call(
                "[yellow]Cannot reload configuration in packaged application.[/yellow]"
            )
            mock_console.print.assert_any_call(
                "[yellow]Please restart Kimi CLI to apply configuration changes.[/yellow]"
            )

            # Verify wait_for_key_press was called
            mock_wait.assert_called_once_with("Press any key to exit...")


class TestWaitForKeyPress:
    """Test wait_for_key_press utility function."""

    @patch("sys.stdout")
    @patch("sys.stdin")
    def test_wait_for_key_press_interactive_windows(self, mock_stdin, mock_stdout):
        """Test wait_for_key_press in interactive Windows environment."""
        from kimi_cli.utils.term import wait_for_key_press

        # Mock interactive environment
        mock_stdout.isatty.return_value = True
        mock_stdin.isatty.return_value = True

        with patch("sys.platform", "win32"), patch("msvcrt.getch") as mock_getch:
            wait_for_key_press("Test message")

            # Verify message was written
            mock_stdout.write.assert_any_call("Test message")
            mock_stdout.write.assert_any_call("\n")
            mock_stdout.flush.assert_called()

            # Verify getch was called
            mock_getch.assert_called_once()

    @patch("sys.stdout")
    @patch("sys.stdin")
    def test_wait_for_key_press_interactive_unix(self, mock_stdin, mock_stdout):
        """Test wait_for_key_press in interactive Unix environment."""
        import sys

        from kimi_cli.utils.term import wait_for_key_press

        # Skip test on Windows since termios is not available
        if sys.platform == "win32":
            import pytest

            pytest.skip("termios module not available on Windows")

        # Mock interactive environment
        mock_stdout.isatty.return_value = True
        mock_stdin.isatty.return_value = True
        mock_stdin.read.return_value = "a"  # Mock user pressing 'a'

        with (
            patch("sys.platform", "linux"),
            patch("termios.tcgetattr") as mock_tcgetattr,
            patch("termios.tcsetattr") as mock_tcsetattr,
            patch("tty.setcbreak") as mock_setcbreak,
            patch("sys.stdin.fileno", return_value=0),
        ):
            wait_for_key_press("Test message")

            # Verify message was written
            mock_stdout.write.assert_any_call("Test message")
            mock_stdout.write.assert_any_call("\n")
            mock_stdout.flush.assert_called()

            # Verify termios functions were called
            mock_tcgetattr.assert_called()
            mock_tcsetattr.assert_called()
            mock_setcbreak.assert_called()

    @patch("sys.stdout")
    @patch("sys.stdin")
    def test_wait_for_key_press_non_interactive(self, mock_stdin, mock_stdout):
        """Test wait_for_key_press in non-interactive environment."""
        from kimi_cli.utils.term import wait_for_key_press

        # Mock non-interactive environment
        mock_stdout.isatty.return_value = False
        mock_stdin.isatty.return_value = True

        # Should return immediately without doing anything
        wait_for_key_press("Test message")

        # Verify no output was written
        mock_stdout.write.assert_not_called()
        mock_stdout.flush.assert_not_called()

    def test_wait_for_key_press_custom_message(self):
        """Test wait_for_key_press with custom message."""
        from kimi_cli.utils.term import wait_for_key_press

        with patch("sys.stdout") as mock_stdout, patch("sys.stdin") as mock_stdin:
            # Mock non-interactive environment to avoid actual key press
            mock_stdout.isatty.return_value = False
            mock_stdin.isatty.return_value = True

            wait_for_key_press("Custom message here")

            # Custom message should not be written in non-interactive mode
            mock_stdout.write.assert_not_called()

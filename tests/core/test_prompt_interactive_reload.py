"""Test that --prompt-interactive does not replay initial_command after Reload.

When --prompt-interactive is used, the prompt_interactive value is passed as
initial_command on the first shell run. After a Reload (e.g. /theme or /model),
_run() is re-entered. The bug is that prompt_interactive was not set to None
after first use, so the same initial_command was passed again on reload.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from kaos.path import KaosPath
from typer.testing import CliRunner

from kimi_cli.cli import Reload, cli


@pytest.fixture
def isolated_share_dir(monkeypatch, tmp_path):
    share_dir = tmp_path / "share"
    share_dir.mkdir()

    def _get_share_dir():
        share_dir.mkdir(parents=True, exist_ok=True)
        return share_dir

    monkeypatch.setattr("kimi_cli.share.get_share_dir", _get_share_dir)
    monkeypatch.setattr("kimi_cli.metadata.get_share_dir", _get_share_dir)
    return share_dir


@pytest.fixture
def work_dir(tmp_path):
    path = tmp_path / "work"
    path.mkdir()
    return KaosPath.unsafe_from_local_path(path)


class TestPromptInteractiveReload:
    def test_initial_command_not_replayed_after_reload(
        self, isolated_share_dir, work_dir, monkeypatch
    ):
        """Bug: after Reload, initial_command should be None, not the original prompt."""

        mock_session = MagicMock()
        mock_session.id = "test-session-id"
        mock_session.work_dir = work_dir
        mock_session.is_empty.return_value = False
        mock_session.wire_file.is_empty.return_value = False
        mock_session.state.additional_dirs = []

        mock_instance = MagicMock()
        mock_instance.soul.hook_engine.trigger = AsyncMock()
        mock_instance.shutdown_background_tasks = AsyncMock()
        mock_instance.await_bg_tasks_shutdown = AsyncMock()

        run_shell_calls = []

        async def run_shell_side_effect(*args, **kwargs):
            run_shell_calls.append(kwargs.copy())
            if len(run_shell_calls) == 1:
                # First call: simulate a slash command that triggers Reload
                raise Reload(session_id="test-session-id")
            # Second call: normal exit
            return True

        mock_instance.run_shell = AsyncMock(side_effect=run_shell_side_effect)

        with (
            patch(
                "kimi_cli.session.Session.create", new_callable=AsyncMock, return_value=mock_session
            ),
            patch(
                "kimi_cli.session.Session.find", new_callable=AsyncMock, return_value=mock_session
            ),
            patch(
                "kimi_cli.app.KimiCLI.create", new_callable=AsyncMock, return_value=mock_instance
            ),
        ):
            result = CliRunner().invoke(
                cli,
                ["--prompt-interactive", "hello", "--work-dir", str(work_dir)],
            )

        # Should succeed after reload (exit code 0)
        assert result.exit_code == 0, result.output

        # run_shell should have been called twice
        assert mock_instance.run_shell.call_count == 2

        # First call: initial_command should be the prompt
        first_call = mock_instance.run_shell.call_args_list[0]
        assert first_call.kwargs.get("initial_command") == "hello"

        # Second call (after Reload): initial_command MUST be None
        # Bug: it is still "hello" because prompt_interactive was not cleared
        second_call = mock_instance.run_shell.call_args_list[1]
        assert second_call.kwargs.get("initial_command") is None

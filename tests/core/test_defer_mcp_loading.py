"""Test defer_mcp_loading logic in CLI entry point.

PR #2246 added --prompt-interactive (-P). The defer_mcp_loading condition at
src/kimi_cli/cli/__init__.py:660 must consider prompt_interactive so that MCP
tools are available immediately when an initial command is provided.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from kaos.path import KaosPath
from typer.testing import CliRunner

from kimi_cli.cli import cli


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


class TestDeferMcpLoading:
    """Verify defer_mcp_loading is passed correctly to KimiCLI.create()."""

    def _setup_mocks(self, work_dir):
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
        mock_instance.run_shell = AsyncMock(return_value=True)

        return mock_session, mock_instance

    def test_shell_no_prompt_defer_mcp_loading(self, isolated_share_dir, work_dir):
        """Plain shell mode (no --prompt, no --prompt-interactive) should defer MCP."""
        mock_session, mock_instance = self._setup_mocks(work_dir)

        with (
            patch(
                "kimi_cli.session.Session.create", new_callable=AsyncMock, return_value=mock_session
            ),
            patch(
                "kimi_cli.session.Session.find", new_callable=AsyncMock, return_value=mock_session
            ),
            patch(
                "kimi_cli.app.KimiCLI.create", new_callable=AsyncMock, return_value=mock_instance
            ) as mock_create,
        ):
            result = CliRunner().invoke(
                cli,
                ["--work-dir", str(work_dir)],
            )

        assert result.exit_code == 0, result.output
        mock_create.assert_called_once()
        assert mock_create.call_args.kwargs.get("defer_mcp_loading") is True

    def test_shell_with_prompt_no_defer(self, isolated_share_dir, work_dir):
        """--prompt should not defer MCP loading."""
        mock_session, mock_instance = self._setup_mocks(work_dir)

        with (
            patch(
                "kimi_cli.session.Session.create", new_callable=AsyncMock, return_value=mock_session
            ),
            patch(
                "kimi_cli.session.Session.find", new_callable=AsyncMock, return_value=mock_session
            ),
            patch(
                "kimi_cli.app.KimiCLI.create", new_callable=AsyncMock, return_value=mock_instance
            ) as mock_create,
        ):
            result = CliRunner().invoke(
                cli,
                ["--prompt", "hello", "--work-dir", str(work_dir)],
            )

        assert result.exit_code == 0, result.output
        mock_create.assert_called_once()
        assert mock_create.call_args.kwargs.get("defer_mcp_loading") is False

    def test_shell_with_prompt_interactive_no_defer(self, isolated_share_dir, work_dir):
        """--prompt-interactive should not defer MCP loading."""
        mock_session, mock_instance = self._setup_mocks(work_dir)

        with (
            patch(
                "kimi_cli.session.Session.create", new_callable=AsyncMock, return_value=mock_session
            ),
            patch(
                "kimi_cli.session.Session.find", new_callable=AsyncMock, return_value=mock_session
            ),
            patch(
                "kimi_cli.app.KimiCLI.create", new_callable=AsyncMock, return_value=mock_instance
            ) as mock_create,
        ):
            result = CliRunner().invoke(
                cli,
                ["--prompt-interactive", "hello", "--work-dir", str(work_dir)],
            )

        assert result.exit_code == 0, result.output
        mock_create.assert_called_once()
        assert mock_create.call_args.kwargs.get("defer_mcp_loading") is False

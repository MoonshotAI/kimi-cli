"""Tests for shell-level slash commands."""

from __future__ import annotations

from collections.abc import Awaitable
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from kaos.path import KaosPath
from kosong.message import Message

from kimi_cli.cli import Reload
from kimi_cli.session import Session
from kimi_cli.ui.shell.slash import ShellSlashCmdFunc, shell_mode_registry
from kimi_cli.ui.shell.slash import registry as shell_slash_registry
from kimi_cli.utils.slashcmd import SlashCommand
from kimi_cli.wire.types import TextPart


async def _invoke_slash_command(command: SlashCommand[ShellSlashCmdFunc], shell: Any) -> None:
    ret = command.func(shell, "")
    if isinstance(ret, Awaitable):
        await ret


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def isolated_share_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Provide an isolated share directory for metadata operations."""
    share_dir = tmp_path / "share"
    share_dir.mkdir()

    def _get_share_dir() -> Path:
        share_dir.mkdir(parents=True, exist_ok=True)
        return share_dir

    monkeypatch.setattr("kimi_cli.share.get_share_dir", _get_share_dir)
    monkeypatch.setattr("kimi_cli.metadata.get_share_dir", _get_share_dir)
    return share_dir


@pytest.fixture
def work_dir(tmp_path: Path) -> KaosPath:
    path = tmp_path / "work"
    path.mkdir()
    return KaosPath.unsafe_from_local_path(path)


@pytest.fixture
def mock_shell(work_dir: KaosPath) -> Mock:
    """Create a mock Shell whose soul passes the KimiSoul isinstance check.

    The mock session is treated as non-empty so that /new does not attempt
    to delete it (delete would fail on a plain Mock because it is not awaitable).
    """
    from kimi_cli.soul.kimisoul import KimiSoul

    mock_soul = Mock(spec=KimiSoul)
    mock_soul.runtime.session.work_dir = work_dir
    mock_soul.runtime.session.id = "current-session-id"
    mock_soul.runtime.session.is_empty.return_value = False

    shell = Mock()
    shell.soul = mock_soul
    return shell


# ---------------------------------------------------------------------------
# /new — registration
# ---------------------------------------------------------------------------


class TestNewCommandRegistration:
    """Verify /new is registered in the correct registries."""

    def test_registered_in_shell_registry(self) -> None:
        cmd = shell_slash_registry.find_command("new")
        assert cmd is not None
        assert cmd.name == "new"
        assert cmd.description == "Start a new session"

    def test_not_in_shell_mode_registry(self) -> None:
        """/new should NOT be available in shell mode (Ctrl-X toggle)."""
        assert shell_mode_registry.find_command("new") is None

    def test_not_in_soul_registry(self) -> None:
        """/new should NOT appear in soul-level commands (Web UI visibility)."""
        from kimi_cli.soul.slash import registry as soul_slash_registry

        assert soul_slash_registry.find_command("new") is None


# ---------------------------------------------------------------------------
# /new — behaviour
# ---------------------------------------------------------------------------


class TestNewCommandBehavior:
    """Verify /new creates a new session and raises Reload."""

    async def test_raises_reload_with_new_session_id(
        self, isolated_share_dir: Path, mock_shell: Mock
    ) -> None:
        cmd = shell_slash_registry.find_command("new")
        assert cmd is not None

        with pytest.raises(Reload) as exc_info:
            await _invoke_slash_command(cmd, mock_shell)

        session_id = exc_info.value.session_id
        assert session_id is not None
        assert session_id != "current-session-id"

    async def test_new_session_persisted_on_disk(
        self, isolated_share_dir: Path, work_dir: KaosPath, mock_shell: Mock
    ) -> None:
        cmd = shell_slash_registry.find_command("new")
        assert cmd is not None

        with pytest.raises(Reload) as exc_info:
            await _invoke_slash_command(cmd, mock_shell)

        session_id = exc_info.value.session_id
        assert session_id is not None
        new_session = await Session.find(work_dir, session_id)
        assert new_session is not None
        assert new_session.context_file.exists()
        assert new_session.context_file.stat().st_size == 0  # empty context

    async def test_consecutive_calls_produce_unique_ids(
        self, isolated_share_dir: Path, mock_shell: Mock
    ) -> None:
        cmd = shell_slash_registry.find_command("new")
        assert cmd is not None

        ids: list[str] = []
        for _ in range(3):
            with pytest.raises(Reload) as exc_info:
                await _invoke_slash_command(cmd, mock_shell)
            session_id = exc_info.value.session_id
            assert session_id is not None
            ids.append(session_id)

        assert len(set(ids)) == 3

    async def test_returns_early_without_kimi_soul(self) -> None:
        """When soul is not a KimiSoul, the command should silently return."""
        shell = Mock()
        shell.soul = Mock()  # plain Mock, not spec=KimiSoul

        cmd = shell_slash_registry.find_command("new")
        assert cmd is not None

        # Should return without raising Reload
        await _invoke_slash_command(cmd, shell)


# ---------------------------------------------------------------------------
# /new — empty-session cleanup
# ---------------------------------------------------------------------------


def _write_context_message(context_file: Path, text: str) -> None:
    """Write a user message to a context file to make the session non-empty."""
    context_file.parent.mkdir(parents=True, exist_ok=True)
    message = Message(role="user", content=[TextPart(text=text)])
    context_file.write_text(message.model_dump_json(exclude_none=True) + "\n", encoding="utf-8")


class TestNewCommandSessionCleanup:
    """Verify /new cleans up the current session when it is empty."""

    async def test_deletes_empty_current_session(
        self, isolated_share_dir: Path, work_dir: KaosPath
    ) -> None:
        """An empty current session should be removed to avoid orphan directories."""
        from kimi_cli.soul.kimisoul import KimiSoul

        empty_session = await Session.create(work_dir)
        assert empty_session.is_empty()
        session_dir = empty_session.work_dir_meta.sessions_dir / empty_session.id
        assert session_dir.exists()

        mock_soul = Mock(spec=KimiSoul)
        mock_soul.runtime.session = empty_session
        shell = Mock()
        shell.soul = mock_soul

        cmd = shell_slash_registry.find_command("new")
        assert cmd is not None
        with pytest.raises(Reload):
            await _invoke_slash_command(cmd, shell)

        # The empty session directory should have been cleaned up
        assert not session_dir.exists()

    async def test_preserves_non_empty_current_session(
        self, isolated_share_dir: Path, work_dir: KaosPath
    ) -> None:
        """A session that already has content must NOT be deleted."""
        from kimi_cli.soul.kimisoul import KimiSoul

        session_with_content = await Session.create(work_dir)
        _write_context_message(session_with_content.context_file, "hello world")
        assert not session_with_content.is_empty()
        session_dir = session_with_content.work_dir_meta.sessions_dir / session_with_content.id

        mock_soul = Mock(spec=KimiSoul)
        mock_soul.runtime.session = session_with_content
        shell = Mock()
        shell.soul = mock_soul

        cmd = shell_slash_registry.find_command("new")
        assert cmd is not None
        with pytest.raises(Reload):
            await _invoke_slash_command(cmd, shell)

        # The non-empty session directory must still exist
        assert session_dir.exists()

    async def test_chained_new_does_not_accumulate_empty_sessions(
        self, isolated_share_dir: Path, work_dir: KaosPath
    ) -> None:
        """Calling /new repeatedly should not leave orphan empty sessions."""
        from kimi_cli.soul.kimisoul import KimiSoul

        cmd = shell_slash_registry.find_command("new")
        assert cmd is not None

        # Simulate: session A (empty) → /new → session B (empty) → /new → session C
        session_a = await Session.create(work_dir)
        dir_a = session_a.work_dir_meta.sessions_dir / session_a.id

        mock_soul = Mock(spec=KimiSoul)
        mock_soul.runtime.session = session_a
        shell = Mock()
        shell.soul = mock_soul

        # First /new: A is empty → cleaned up, B created
        with pytest.raises(Reload) as exc_info:
            await _invoke_slash_command(cmd, shell)
        session_b_id = exc_info.value.session_id
        assert session_b_id is not None
        session_b = await Session.find(work_dir, session_b_id)
        assert session_b is not None
        dir_b = session_b.work_dir_meta.sessions_dir / session_b.id

        assert not dir_a.exists()  # A cleaned up
        assert dir_b.exists()  # B exists

        # Second /new: B is empty → cleaned up, C created
        mock_soul.runtime.session = session_b
        with pytest.raises(Reload) as exc_info:
            await _invoke_slash_command(cmd, shell)
        session_c_id = exc_info.value.session_id
        assert session_c_id is not None

        assert not dir_b.exists()  # B cleaned up
        session_c = await Session.find(work_dir, session_c_id)
        assert session_c is not None

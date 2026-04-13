"""Tests for shell-level slash commands."""

from __future__ import annotations

from collections.abc import Awaitable
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from kaos.path import KaosPath
from kosong.message import Message
from rich.text import Text

from kimi_cli.cli import Reload
from kimi_cli.metadata import load_metadata, save_metadata
from kimi_cli.session import Session
from kimi_cli.ui.shell import slash as shell_slash
from kimi_cli.ui.shell.slash import ShellSlashCmdFunc, shell_mode_registry
from kimi_cli.ui.shell.slash import registry as shell_slash_registry
from kimi_cli.utils.slashcmd import SlashCommand
from kimi_cli.wire.types import TextPart


async def _invoke_slash_command(
    command: SlashCommand[ShellSlashCmdFunc], shell: Any, args: str = ""
) -> None:
    ret = command.func(shell, args)
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


# ---------------------------------------------------------------------------
# /delete (/remove) — registration
# ---------------------------------------------------------------------------


class TestDeleteCommandRegistration:
    """Verify /delete is registered in shell registry only."""

    def test_registered_in_shell_registry(self) -> None:
        cmd = shell_slash_registry.find_command("delete")
        assert cmd is not None
        assert cmd.name == "delete"
        assert "remove" in cmd.aliases

    def test_alias_registered(self) -> None:
        cmd = shell_slash_registry.find_command("remove")
        assert cmd is not None
        assert cmd.name == "delete"

    def test_not_in_shell_mode_registry(self) -> None:
        assert shell_mode_registry.find_command("delete") is None

    def test_not_in_soul_registry(self) -> None:
        from kimi_cli.soul.slash import registry as soul_slash_registry

        assert soul_slash_registry.find_command("delete") is None

    def test_usage_message_renders_literal_session_id_placeholder(self) -> None:
        plain = Text.from_markup(shell_slash._DELETE_USAGE).plain
        assert plain == "Usage: /delete [session_id]"


async def _make_shell_with_session(work_dir: KaosPath) -> tuple[Mock, Session]:
    from kimi_cli.soul.kimisoul import KimiSoul

    current_session = await Session.create(work_dir)
    mock_soul = Mock(spec=KimiSoul)
    mock_soul.runtime.session = current_session
    shell = Mock()
    shell.soul = mock_soul
    return shell, current_session


# ---------------------------------------------------------------------------
# /delete (/remove) — behavior
# ---------------------------------------------------------------------------


class TestDeleteCommandBehavior:
    async def test_delete_by_id_removes_target_session(
        self, isolated_share_dir: Path, work_dir: KaosPath, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        shell, current = await _make_shell_with_session(work_dir)
        target = await Session.create(work_dir)

        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)
        monkeypatch.setattr(shell_slash, "_confirm_delete", lambda *_args, **_kwargs: True)

        cmd = shell_slash_registry.find_command("delete")
        assert cmd is not None
        await _invoke_slash_command(cmd, shell, target.id)

        assert await Session.find(work_dir, target.id) is None
        assert await Session.find(work_dir, current.id) is not None
        assert any("Deleted session" in str(call.args[0]) for call in print_mock.call_args_list)

    async def test_delete_without_args_uses_picker_and_deletes(
        self, isolated_share_dir: Path, work_dir: KaosPath, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        shell, _ = await _make_shell_with_session(work_dir)
        target = await Session.create(work_dir)

        class _Picker:
            def __init__(self, **_kwargs) -> None:
                return

            async def run(self) -> tuple[str, KaosPath]:
                return target.id, work_dir

        monkeypatch.setattr(shell_slash, "SessionPickerApp", _Picker)
        monkeypatch.setattr(shell_slash, "_confirm_delete", lambda *_args, **_kwargs: True)

        cmd = shell_slash_registry.find_command("delete")
        assert cmd is not None
        await _invoke_slash_command(cmd, shell)

        assert await Session.find(work_dir, target.id) is None

    async def test_delete_rejects_cross_work_dir_selection(
        self,
        isolated_share_dir: Path,
        work_dir: KaosPath,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        shell, _ = await _make_shell_with_session(work_dir)
        other_path = tmp_path / "other-work-dir"
        other_path.mkdir()
        other_work_dir = KaosPath.unsafe_from_local_path(other_path)
        other_session = await Session.create(other_work_dir)

        class _Picker:
            def __init__(self, **_kwargs) -> None:
                return

            async def run(self) -> tuple[str, KaosPath]:
                return other_session.id, other_work_dir

        print_mock = Mock()
        monkeypatch.setattr(shell_slash, "SessionPickerApp", _Picker)
        monkeypatch.setattr(shell_slash.console, "print", print_mock)

        cmd = shell_slash_registry.find_command("delete")
        assert cmd is not None
        await _invoke_slash_command(cmd, shell)

        assert await Session.find(other_work_dir, other_session.id) is not None
        assert any(
            "different working directory" in str(call.args[0]) for call in print_mock.call_args_list
        )

    async def test_delete_rejects_invalid_session_id(
        self, isolated_share_dir: Path, work_dir: KaosPath, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        shell, _ = await _make_shell_with_session(work_dir)
        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)

        cmd = shell_slash_registry.find_command("delete")
        assert cmd is not None
        await _invoke_slash_command(cmd, shell, "../bad")

        assert any("Invalid session id" in str(call.args[0]) for call in print_mock.call_args_list)

    async def test_delete_rejects_current_session(
        self, isolated_share_dir: Path, work_dir: KaosPath, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        shell, current = await _make_shell_with_session(work_dir)
        print_mock = Mock()
        confirm_called = False

        def _confirm(*_args: object, **_kwargs: object) -> bool:
            nonlocal confirm_called
            confirm_called = True
            return True

        monkeypatch.setattr(shell_slash.console, "print", print_mock)
        monkeypatch.setattr(shell_slash, "_confirm_delete", _confirm)

        cmd = shell_slash_registry.find_command("delete")
        assert cmd is not None
        await _invoke_slash_command(cmd, shell, current.id)

        assert await Session.find(work_dir, current.id) is not None
        assert not confirm_called
        assert any(
            "Cannot delete the current session" in str(call.args[0])
            for call in print_mock.call_args_list
        )

    async def test_delete_eof_from_confirmation_is_treated_as_cancelled(
        self, isolated_share_dir: Path, work_dir: KaosPath, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        shell, _ = await _make_shell_with_session(work_dir)
        target = await Session.create(work_dir)
        print_mock = Mock()

        def _confirm_raises_eof(*_args: object, **_kwargs: object) -> bool:
            raise EOFError

        monkeypatch.setattr(shell_slash.console, "print", print_mock)
        monkeypatch.setattr(shell_slash, "_confirm_delete", _confirm_raises_eof)

        cmd = shell_slash_registry.find_command("delete")
        assert cmd is not None
        await _invoke_slash_command(cmd, shell, target.id)

        assert await Session.find(work_dir, target.id) is not None
        assert any("Deletion cancelled" in str(call.args[0]) for call in print_mock.call_args_list)

    async def test_delete_not_found(
        self, isolated_share_dir: Path, work_dir: KaosPath, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        shell, _ = await _make_shell_with_session(work_dir)
        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)

        cmd = shell_slash_registry.find_command("delete")
        assert cmd is not None
        await _invoke_slash_command(cmd, shell, "missing-session")

        assert any("Session not found" in str(call.args[0]) for call in print_mock.call_args_list)

    async def test_delete_shows_usage_when_too_many_args(
        self, isolated_share_dir: Path, work_dir: KaosPath, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        shell, _ = await _make_shell_with_session(work_dir)
        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)

        cmd = shell_slash_registry.find_command("delete")
        assert cmd is not None
        await _invoke_slash_command(cmd, shell, "a b")

        assert any("Usage: /delete" in str(call.args[0]) for call in print_mock.call_args_list)

    async def test_delete_failure_does_not_clear_last_session_id(
        self, isolated_share_dir: Path, work_dir: KaosPath, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        shell, _ = await _make_shell_with_session(work_dir)
        target = await Session.create(work_dir)

        metadata = load_metadata()
        work_dir_meta = metadata.get_work_dir_meta(work_dir)
        assert work_dir_meta is not None
        work_dir_meta.last_session_id = target.id
        save_metadata(metadata)

        async def _raise_delete(_self: Session) -> None:
            raise OSError("boom")

        monkeypatch.setattr(shell_slash, "_confirm_delete", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(Session, "delete", _raise_delete)

        cmd = shell_slash_registry.find_command("delete")
        assert cmd is not None
        await _invoke_slash_command(cmd, shell, target.id)

        metadata_after = load_metadata()
        work_dir_meta_after = metadata_after.get_work_dir_meta(work_dir)
        assert work_dir_meta_after is not None
        assert work_dir_meta_after.last_session_id == target.id
        assert await Session.find(work_dir, target.id) is not None

    async def test_delete_metadata_cleanup_failure_warns_but_keeps_delete(
        self, isolated_share_dir: Path, work_dir: KaosPath, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        shell, _ = await _make_shell_with_session(work_dir)
        target = await Session.create(work_dir)

        metadata = load_metadata()
        work_dir_meta = metadata.get_work_dir_meta(work_dir)
        assert work_dir_meta is not None
        work_dir_meta.last_session_id = target.id
        save_metadata(metadata)

        print_mock = Mock()

        def _raise_save(_metadata: object) -> None:
            raise OSError("cannot save metadata")

        monkeypatch.setattr(shell_slash.console, "print", print_mock)
        monkeypatch.setattr(shell_slash, "_confirm_delete", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(shell_slash, "save_metadata", _raise_save)

        cmd = shell_slash_registry.find_command("delete")
        assert cmd is not None
        await _invoke_slash_command(cmd, shell, target.id)

        assert await Session.find(work_dir, target.id) is None
        assert any(
            "failed to update metadata" in str(call.args[0]).lower()
            for call in print_mock.call_args_list
        )
        assert not any("Deleted session" in str(call.args[0]) for call in print_mock.call_args_list)

    async def test_remove_alias_matches_delete_behavior(
        self, isolated_share_dir: Path, work_dir: KaosPath, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        shell, _ = await _make_shell_with_session(work_dir)
        target = await Session.create(work_dir)
        monkeypatch.setattr(shell_slash, "_confirm_delete", lambda *_args, **_kwargs: True)

        cmd = shell_slash_registry.find_command("remove")
        assert cmd is not None
        await _invoke_slash_command(cmd, shell, target.id)

        assert await Session.find(work_dir, target.id) is None

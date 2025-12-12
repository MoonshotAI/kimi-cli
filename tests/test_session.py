from __future__ import annotations

import os
from pathlib import Path

import pytest

from kaos import reset_current_kaos, set_current_kaos
from kaos.local import LocalKaos
from kaos.path import KaosPath
from kimi_cli.metadata import load_metadata
from kimi_cli.session import Session


@pytest.fixture
def isolated_share_dir(monkeypatch, tmp_path: Path) -> Path:
    """Provide an isolated share directory for metadata operations."""

    share_dir = tmp_path / "share"
    share_dir.mkdir()

    def _get_share_dir() -> Path:
        share_dir.mkdir(parents=True, exist_ok=True)
        return share_dir

    monkeypatch.setattr("kimi_cli.share.get_share_dir", _get_share_dir)
    monkeypatch.setattr("kimi_cli.metadata.get_share_dir", _get_share_dir)
    monkeypatch.setattr("kimi_cli.session.get_share_dir", _get_share_dir)
    return share_dir


@pytest.fixture
def kaos_context(tmp_path: Path):
    """Set up a Kaos context for async operations."""
    token = set_current_kaos(LocalKaos())
    old_cwd = Path.cwd()
    os.chdir(tmp_path)
    try:
        yield
    finally:
        os.chdir(old_cwd)
        reset_current_kaos(token)


async def test_session_create(kaos_context, isolated_share_dir: Path, tmp_path: Path):
    """Test creating a new session."""
    work_dir = KaosPath.unsafe_from_local_path(tmp_path / "work")
    await work_dir.mkdir()

    session = await Session.create(work_dir)

    assert session.id is not None
    assert session.work_dir == work_dir
    assert session.context_file.name == "context.jsonl"
    # Context file directory should exist
    assert session.context_file.parent.exists()

    # Verify metadata was updated
    metadata = load_metadata()
    assert session.id in metadata.session_to_workdir
    assert metadata.session_to_workdir[session.id] == str(work_dir)


async def test_session_create_multiple_sessions(
    kaos_context, isolated_share_dir: Path, tmp_path: Path
):
    """Test creating multiple sessions for the same work directory."""
    work_dir = KaosPath.unsafe_from_local_path(tmp_path / "work")
    await work_dir.mkdir()

    session1 = await Session.create(work_dir)
    session2 = await Session.create(work_dir)

    assert session1.id != session2.id
    assert session1.work_dir == session2.work_dir
    assert session1.context_file.parent != session2.context_file.parent

    # Verify both sessions are in metadata
    metadata = load_metadata()
    assert session1.id in metadata.session_to_workdir
    assert session2.id in metadata.session_to_workdir


async def test_session_create_different_work_dirs(
    kaos_context, isolated_share_dir: Path, tmp_path: Path
):
    """Test creating sessions for different work directories."""
    work_dir1 = KaosPath.unsafe_from_local_path(tmp_path / "work1")
    work_dir2 = KaosPath.unsafe_from_local_path(tmp_path / "work2")
    await work_dir1.mkdir()
    await work_dir2.mkdir()

    session1 = await Session.create(work_dir1)
    session2 = await Session.create(work_dir2)

    assert session1.work_dir != session2.work_dir
    assert session1.id != session2.id

    # Verify both sessions are in metadata
    metadata = load_metadata()
    assert metadata.session_to_workdir[session1.id] == str(work_dir1)
    assert metadata.session_to_workdir[session2.id] == str(work_dir2)


async def test_session_continue_no_previous_session(
    kaos_context, isolated_share_dir: Path, tmp_path: Path
):
    """Test continuing when no previous session exists."""
    work_dir = KaosPath.unsafe_from_local_path(tmp_path / "work")
    await work_dir.mkdir()

    session = await Session.continue_(work_dir)

    assert session is None


async def test_session_continue_with_previous_session(
    kaos_context, isolated_share_dir: Path, tmp_path: Path
):
    """Test continuing a previous session."""
    work_dir = KaosPath.unsafe_from_local_path(tmp_path / "work")
    await work_dir.mkdir()

    # Create a session first
    created_session = await Session.create(work_dir)

    # Update metadata to mark it as last session
    metadata = load_metadata()
    work_dir_meta = next((wd for wd in metadata.work_dirs if wd.path == str(work_dir)), None)
    assert work_dir_meta is not None
    work_dir_meta.last_session_id = created_session.id
    from kimi_cli.metadata import save_metadata

    save_metadata(metadata)

    # Now continue
    continued_session = await Session.continue_(work_dir)

    assert continued_session is not None
    assert continued_session.id == created_session.id
    assert continued_session.work_dir == created_session.work_dir
    assert continued_session.context_file == created_session.context_file


async def test_session_load_by_id_valid(kaos_context, isolated_share_dir: Path, tmp_path: Path):
    """Test loading a session by valid ID."""
    work_dir = KaosPath.unsafe_from_local_path(tmp_path / "work")
    await work_dir.mkdir()

    created_session = await Session.create(work_dir)
    session_id = created_session.id

    # Create the context file (Session.create doesn't create it, only sets the path)
    created_session.context_file.parent.mkdir(parents=True, exist_ok=True)
    created_session.context_file.touch()

    loaded_session = Session.load_by_id(session_id)

    assert loaded_session is not None
    assert loaded_session.id == created_session.id
    assert loaded_session.work_dir == created_session.work_dir
    assert loaded_session.context_file == created_session.context_file


def test_session_load_by_id_nonexistent(kaos_context, isolated_share_dir: Path):
    """Test loading a non-existent session ID."""
    import uuid

    nonexistent_id = str(uuid.uuid4())
    loaded_session = Session.load_by_id(nonexistent_id)

    assert loaded_session is None


async def test_session_load_by_id_different_work_dir(
    kaos_context, isolated_share_dir: Path, tmp_path: Path
):
    """Test loading a session from a different work directory."""
    work_dir1 = KaosPath.unsafe_from_local_path(tmp_path / "work1")
    work_dir2 = KaosPath.unsafe_from_local_path(tmp_path / "work2")
    await work_dir1.mkdir()
    await work_dir2.mkdir()

    session1 = await Session.create(work_dir1)
    session2 = await Session.create(work_dir2)

    # Create context files
    session1.context_file.parent.mkdir(parents=True, exist_ok=True)
    session1.context_file.touch()
    session2.context_file.parent.mkdir(parents=True, exist_ok=True)
    session2.context_file.touch()

    # Load session1 from work_dir2 context
    loaded_session = Session.load_by_id(session1.id)

    assert loaded_session is not None
    assert loaded_session.id == session1.id
    assert loaded_session.work_dir == work_dir1  # Should use original work_dir


async def test_session_load_by_id_filesystem_fallback(
    kaos_context, isolated_share_dir: Path, tmp_path: Path
):
    """Test filesystem fallback when session not in metadata."""
    work_dir = KaosPath.unsafe_from_local_path(tmp_path / "work")
    await work_dir.mkdir()

    # Create a session
    created_session = await Session.create(work_dir)
    session_id = created_session.id

    # Create the context file
    created_session.context_file.parent.mkdir(parents=True, exist_ok=True)
    created_session.context_file.touch()

    # Remove from metadata to simulate old session
    metadata = load_metadata()
    del metadata.session_to_workdir[session_id]
    from kimi_cli.metadata import save_metadata

    save_metadata(metadata)

    # Load should still work via filesystem fallback
    loaded_session = Session.load_by_id(session_id)

    assert loaded_session is not None
    assert loaded_session.id == session_id
    assert loaded_session.work_dir == work_dir

    # Verify metadata was auto-populated
    metadata = load_metadata()
    assert session_id in metadata.session_to_workdir
    assert metadata.session_to_workdir[session_id] == str(work_dir)


async def test_session_load_by_id_history_file_missing(
    kaos_context, isolated_share_dir: Path, tmp_path: Path
):
    """Test loading a session when context file is missing."""
    work_dir = KaosPath.unsafe_from_local_path(tmp_path / "work")
    await work_dir.mkdir()

    # Create a session
    created_session = await Session.create(work_dir)
    session_id = created_session.id

    # Create and then remove context file
    created_session.context_file.parent.mkdir(parents=True, exist_ok=True)
    created_session.context_file.touch()
    created_session.context_file.unlink(missing_ok=True)

    # Remove from metadata
    metadata = load_metadata()
    del metadata.session_to_workdir[session_id]
    from kimi_cli.metadata import save_metadata

    save_metadata(metadata)

    # Load should fail
    loaded_session = Session.load_by_id(session_id)

    assert loaded_session is None


async def test_session_create_truncates_existing_history(
    kaos_context, isolated_share_dir: Path, tmp_path: Path
):
    """Test that creating a session truncates existing context file when using same context file."""
    work_dir = KaosPath.unsafe_from_local_path(tmp_path / "work")
    await work_dir.mkdir()

    # Create first session
    session1 = await Session.create(work_dir)
    context_file = session1.context_file

    # Create the context file and write content
    context_file.parent.mkdir(parents=True, exist_ok=True)
    context_file.write_text("some history content\n")

    # Create second session with the same context file (using _context_file parameter)
    await Session.create(work_dir, _context_file=context_file)

    # Context file should be empty (truncated)
    assert context_file.exists()
    assert context_file.read_text() == ""


async def test_session_continue_updates_last_session_id(
    kaos_context, isolated_share_dir: Path, tmp_path: Path
):
    """Test that continuing a session updates last_session_id in metadata."""
    work_dir = KaosPath.unsafe_from_local_path(tmp_path / "work")
    await work_dir.mkdir()

    # Create multiple sessions
    session1 = await Session.create(work_dir)
    await Session.create(work_dir)  # Create second session

    # Manually set last_session_id to session1
    metadata = load_metadata()
    work_dir_meta = next((wd for wd in metadata.work_dirs if wd.path == str(work_dir)), None)
    assert work_dir_meta is not None
    work_dir_meta.last_session_id = session1.id
    from kimi_cli.metadata import save_metadata

    save_metadata(metadata)

    # Continue should return session1
    continued = await Session.continue_(work_dir)
    assert continued is not None
    assert continued.id == session1.id

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from kaos.path import KaosPath
from kosong.message import Message

from kimi_cli.session import Session
from kimi_cli.wire.file import WireFileMetadata, WireMessageRecord
from kimi_cli.wire.protocol import WIRE_PROTOCOL_VERSION
from kimi_cli.wire.types import TextPart, TurnBegin


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
    return share_dir


@pytest.fixture
def work_dir(tmp_path: Path) -> KaosPath:
    path = tmp_path / "work"
    path.mkdir()
    return KaosPath.unsafe_from_local_path(path)


def _write_wire_turn(session_dir: Path, text: str):
    wire_file = session_dir / "wire.jsonl"
    wire_file.parent.mkdir(parents=True, exist_ok=True)
    metadata = WireFileMetadata(protocol_version=WIRE_PROTOCOL_VERSION)
    record = WireMessageRecord.from_wire_message(
        TurnBegin(user_input=[TextPart(text=text)]),
        timestamp=time.time(),
    )
    with wire_file.open("w", encoding="utf-8") as f:
        f.write(json.dumps(metadata.model_dump(mode="json")) + "\n")
        f.write(json.dumps(record.model_dump(mode="json")) + "\n")


def _write_wire_metadata(session_dir: Path):
    wire_file = session_dir / "wire.jsonl"
    wire_file.parent.mkdir(parents=True, exist_ok=True)
    metadata = WireFileMetadata(protocol_version=WIRE_PROTOCOL_VERSION)
    wire_file.write_text(
        json.dumps(metadata.model_dump(mode="json")) + "\n",
        encoding="utf-8",
    )


def _write_context_message(context_file: Path, text: str):
    context_file.parent.mkdir(parents=True, exist_ok=True)
    message = Message(role="user", content=[TextPart(text=text)])
    context_file.write_text(message.model_dump_json(exclude_none=True) + "\n", encoding="utf-8")


def _write_context_records(context_file: Path, *records: dict[str, object]) -> None:
    context_file.parent.mkdir(parents=True, exist_ok=True)
    context_file.write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )


async def test_create_sets_fallback_title(isolated_share_dir: Path, work_dir: KaosPath):
    session = await Session.create(work_dir)
    assert session.title == "Untitled"
    assert session.context_file.exists()


async def test_find_uses_wire_title(isolated_share_dir: Path, work_dir: KaosPath):
    session = await Session.create(work_dir)
    _write_wire_turn(session.dir, "hello world from wire file")

    found = await Session.find(work_dir, session.id)
    assert found is not None
    assert found.title == "hello world from wire file"


async def test_list_sorts_by_updated_and_titles(isolated_share_dir: Path, work_dir: KaosPath):
    first = await Session.create(work_dir)
    second = await Session.create(work_dir)

    _write_context_message(first.context_file, "old context message")
    _write_context_message(second.context_file, "new context message")
    _write_wire_turn(first.dir, "old session title")
    _write_wire_turn(second.dir, "new session title that is slightly longer")

    # make sure ordering differs
    now = time.time()
    os.utime(first.context_file, (now - 10, now - 10))
    os.utime(second.context_file, (now, now))
    sessions = await Session.list(work_dir)

    assert [s.id for s in sessions] == [second.id, first.id]
    assert sessions[0].title == "new session title that is slightly longer"
    assert sessions[1].title == "old session title"


async def test_continue_without_last_returns_none(isolated_share_dir: Path, work_dir: KaosPath):
    result = await Session.continue_(work_dir)
    assert result is None


async def test_list_ignores_empty_sessions(isolated_share_dir: Path, work_dir: KaosPath):
    empty = await Session.create(work_dir)
    populated = await Session.create(work_dir)

    _write_wire_metadata(empty.dir)
    _write_context_message(populated.context_file, "persisted user message")
    _write_wire_turn(populated.dir, "populated session")

    sessions = await Session.list(work_dir)

    assert [s.id for s in sessions] == [populated.id]
    assert all(s.id != empty.id for s in sessions)


async def test_is_empty_ignores_context_metadata_only(
    isolated_share_dir: Path, work_dir: KaosPath
) -> None:
    session = await Session.create(work_dir)

    _write_context_records(
        session.context_file,
        {"role": "_system_prompt", "content": "Persisted prompt"},
        {"role": "_checkpoint", "id": 0},
        {"role": "_usage", "token_count": 42},
    )

    assert session.is_empty()


async def test_list_ignores_prompt_only_sessions(
    isolated_share_dir: Path, work_dir: KaosPath
) -> None:
    prompt_only = await Session.create(work_dir)
    populated = await Session.create(work_dir)

    _write_context_records(
        prompt_only.context_file,
        {"role": "_system_prompt", "content": "Persisted prompt"},
    )
    _write_context_message(populated.context_file, "persisted user message")
    _write_wire_turn(populated.dir, "populated session")

    sessions = await Session.list(work_dir)

    assert [s.id for s in sessions] == [populated.id]
    assert all(s.id != prompt_only.id for s in sessions)


async def test_create_named_session(isolated_share_dir: Path, work_dir: KaosPath):
    session_id = "my-named-session"
    session = await Session.create(work_dir, session_id)
    assert session.id == session_id
    assert session.dir.name == session_id

    # Verify we can find it
    found = await Session.find(work_dir, session_id)
    assert found is not None
    assert found.id == session_id


async def test_custom_title_overrides_wire_title(isolated_share_dir: Path, work_dir: KaosPath):
    """custom_title in SessionState takes precedence over wire-derived title."""
    from kimi_cli.session_state import save_session_state

    session = await Session.create(work_dir)
    _write_wire_turn(session.dir, "wire derived title")

    session.state.custom_title = "My Custom Title"
    save_session_state(session.state, session.dir)

    await session.refresh()
    assert session.title == "My Custom Title"


async def test_custom_title_makes_session_non_empty(isolated_share_dir: Path, work_dir: KaosPath):
    """A session with custom_title but no messages should not be considered empty."""
    from kimi_cli.session_state import save_session_state

    session = await Session.create(work_dir)
    assert session.is_empty()

    session.state.custom_title = "Named Session"
    save_session_state(session.state, session.dir)

    assert not session.is_empty()


async def test_custom_title_persists_across_find(isolated_share_dir: Path, work_dir: KaosPath):
    """custom_title should persist when session is loaded via Session.find()."""
    from kimi_cli.session_state import save_session_state

    session = await Session.create(work_dir)
    _write_context_message(session.context_file, "a message")

    session.state.custom_title = "Persisted Title"
    save_session_state(session.state, session.dir)

    found = await Session.find(work_dir, session.id)
    assert found is not None
    assert found.title == "Persisted Title"


async def test_save_state_preserves_external_title(isolated_share_dir: Path, work_dir: KaosPath):
    """save_state() should not overwrite title changes made externally (e.g., web PATCH)."""
    from kimi_cli.session_state import load_session_state, save_session_state

    session = await Session.create(work_dir)

    # Simulate web PATCH writing title directly to disk
    state_on_disk = load_session_state(session.dir)
    state_on_disk.custom_title = "Web Renamed"
    state_on_disk.title_generated = True
    save_session_state(state_on_disk, session.dir)

    # Worker's in-memory state still has no title
    assert session.state.custom_title is None

    # Worker changes plan_mode and saves
    session.state.plan_mode = True
    session.save_state()

    # The web rename should be preserved, not overwritten
    reloaded = load_session_state(session.dir)
    assert reloaded.custom_title == "Web Renamed"
    assert reloaded.title_generated is True
    assert reloaded.plan_mode is True


async def test_save_state_preserves_external_archive(isolated_share_dir: Path, work_dir: KaosPath):
    """save_state() should not overwrite archive changes made externally."""
    from kimi_cli.session_state import load_session_state, save_session_state

    session = await Session.create(work_dir)

    # Simulate web PATCH archiving the session
    state_on_disk = load_session_state(session.dir)
    state_on_disk.archived = True
    state_on_disk.archived_at = 12345.0
    save_session_state(state_on_disk, session.dir)

    # Worker's in-memory state still has archived=False
    assert session.state.archived is False

    # Worker toggles yolo and saves
    session.state.approval.yolo = True
    session.save_state()

    # The archive should be preserved
    reloaded = load_session_state(session.dir)
    assert reloaded.archived is True
    assert reloaded.archived_at == 12345.0
    assert reloaded.approval.yolo is True


async def test_title_never_contains_session_id(isolated_share_dir: Path, work_dir: KaosPath):
    """session.title should be a pure title without the session id suffix."""
    # Untitled session
    session = await Session.create(work_dir)
    assert session.id not in session.title
    assert session.title == "Untitled"

    # Wire-derived title
    _write_wire_turn(session.dir, "my wire title")
    await session.refresh()
    assert session.id not in session.title
    assert session.title == "my wire title"

    # Custom title
    from kimi_cli.session_state import save_session_state

    session.state.custom_title = "My Custom Title"
    save_session_state(session.state, session.dir)
    await session.refresh()
    assert session.id not in session.title
    assert session.title == "My Custom Title"


async def test_list_titles_are_pure(isolated_share_dir: Path, work_dir: KaosPath):
    """Session.list() should return sessions with pure titles (no id suffix)."""
    s1 = await Session.create(work_dir)
    s2 = await Session.create(work_dir)

    _write_context_message(s1.context_file, "msg1")
    _write_context_message(s2.context_file, "msg2")
    _write_wire_turn(s1.dir, "first session")
    _write_wire_turn(s2.dir, "second session")

    sessions = await Session.list(work_dir)
    for s in sessions:
        assert s.id not in s.title
        assert "(" not in s.title


async def test_refresh_without_wire_or_custom_title(isolated_share_dir: Path, work_dir: KaosPath):
    """refresh() with no wire and no custom_title should give 'Untitled'."""
    session = await Session.create(work_dir)
    await session.refresh()
    assert session.title == "Untitled"


async def test_refresh_custom_title_takes_priority_over_wire(
    isolated_share_dir: Path, work_dir: KaosPath
):
    """Even with wire content, custom_title wins."""
    from kimi_cli.session_state import save_session_state

    session = await Session.create(work_dir)
    _write_wire_turn(session.dir, "wire title should be ignored")

    session.state.custom_title = "User Title"
    save_session_state(session.state, session.dir)
    await session.refresh()
    assert session.title == "User Title"


async def test_save_state_reload_does_not_lose_worker_fields(
    isolated_share_dir: Path, work_dir: KaosPath
):
    """save_state() reloads title/archive but preserves worker-owned fields."""
    from kimi_cli.session_state import load_session_state, save_session_state

    session = await Session.create(work_dir)

    # Worker sets plan_mode and additional_dirs
    session.state.plan_mode = True
    session.state.additional_dirs = ["/tmp/extra"]
    session.state.approval.yolo = True

    # External writes title
    fresh = load_session_state(session.dir)
    fresh.custom_title = "External Title"
    save_session_state(fresh, session.dir)

    # Worker saves
    session.save_state()

    # Both worker fields and external title should be preserved
    result = load_session_state(session.dir)
    assert result.plan_mode is True
    assert result.additional_dirs == ["/tmp/extra"]
    assert result.approval.yolo is True
    assert result.custom_title == "External Title"


async def test_is_empty_with_only_metadata_records(
    isolated_share_dir: Path, work_dir: KaosPath
) -> None:
    """Session with only metadata records and no custom_title is empty."""
    session = await Session.create(work_dir)
    _write_context_records(
        session.context_file,
        {"role": "_system_prompt", "content": "Persisted prompt"},
        {"role": "_checkpoint", "id": 0},
    )
    assert session.is_empty()


async def test_new_does_not_delete_titled_session(isolated_share_dir: Path, work_dir: KaosPath):
    """A session with custom_title but no messages should survive /new cleanup logic."""
    from kimi_cli.session_state import save_session_state

    session = await Session.create(work_dir)
    session.state.custom_title = "Keep Me"
    save_session_state(session.state, session.dir)

    # Simulate what /new does: check is_empty, delete if empty
    assert not session.is_empty()
    # Session dir should still exist
    assert session.dir.exists()

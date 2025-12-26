from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from kaos.path import KaosPath
from kosong.message import Message, TextPart

from kimi_cli.session import Session
from kimi_cli.wire.message import TurnBegin
from kimi_cli.wire.serde import WireMessageRecord


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
    record = WireMessageRecord.from_wire_message(
        TurnBegin(user_input=[TextPart(text=text)]),
        timestamp=time.time(),
    )
    with wire_file.open("w", encoding="utf-8") as f:
        f.write(json.dumps(record.model_dump(mode="json")) + "\n")


def _write_context_message(context_file: Path, text: str):
    context_file.parent.mkdir(parents=True, exist_ok=True)
    message = Message(role="user", content=[TextPart(text=text)])
    context_file.write_text(message.model_dump_json(exclude_none=True) + "\n", encoding="utf-8")


async def test_create_sets_fallback_title(isolated_share_dir: Path, work_dir: KaosPath):
    session = await Session.create(work_dir)
    assert session.title.startswith("Untitled (")
    assert session.context_file.exists()


async def test_find_uses_wire_title(isolated_share_dir: Path, work_dir: KaosPath):
    session = await Session.create(work_dir)
    _write_wire_turn(session.dir, "hello world from wire file")

    found = await Session.find(work_dir, session.id)
    assert found is not None
    assert found.title.startswith("hello world from wire file")


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
    assert sessions[0].title.startswith("new session title")
    assert sessions[1].title.startswith("old session title")


async def test_continue_without_last_returns_none(isolated_share_dir: Path, work_dir: KaosPath):
    result = await Session.continue_(work_dir)
    assert result is None


async def test_list_ignores_empty_sessions(isolated_share_dir: Path, work_dir: KaosPath):
    empty = await Session.create(work_dir)
    populated = await Session.create(work_dir)

    _write_context_message(populated.context_file, "persisted user message")
    _write_wire_turn(populated.dir, "populated session")

    sessions = await Session.list(work_dir)

    assert [s.id for s in sessions] == [populated.id]
    assert all(s.id != empty.id for s in sessions)


async def test_create_named_session(isolated_share_dir: Path, work_dir: KaosPath):
    session_id = "my-named-session"
    session = await Session.create(work_dir, session_id)
    assert session.id == session_id
    assert session.dir.name == session_id

    # Verify we can find it
    found = await Session.find(work_dir, session_id)
    assert found is not None
    assert found.id == session_id

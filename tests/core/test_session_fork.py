"""Tests for kimi_cli.session_fork module."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from kaos.path import KaosPath
from kosong.message import Message

from kimi_cli.session_fork import (
    TurnInfo,
    _extract_user_text,
    _is_checkpoint_user_message,
    enumerate_turns,
    fork_session,
    truncate_context_at_turn,
    truncate_wire_at_turn,
)
from kimi_cli.wire.file import WireFileMetadata, WireMessageRecord  # noqa: I001
from kimi_cli.wire.protocol import WIRE_PROTOCOL_VERSION
from kimi_cli.wire.types import TextPart, TurnBegin, TurnEnd

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def isolated_share_dir(monkeypatch, tmp_path: Path) -> Path:
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
def session_dir(tmp_path: Path) -> Path:
    d = tmp_path / "session"
    d.mkdir()
    return d


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_wire_file(session_dir: Path, turns: list[str]) -> Path:
    """Write a wire.jsonl with N turns, each with a TurnBegin and TurnEnd."""
    wire_path = session_dir / "wire.jsonl"
    metadata = WireFileMetadata(protocol_version=WIRE_PROTOCOL_VERSION)
    ts = time.time()

    with wire_path.open("w", encoding="utf-8") as f:
        f.write(json.dumps(metadata.model_dump(mode="json")) + "\n")
        for text in turns:
            begin = WireMessageRecord.from_wire_message(
                TurnBegin(user_input=[TextPart(text=text)]),
                timestamp=ts,
            )
            f.write(json.dumps(begin.model_dump(mode="json")) + "\n")
            end = WireMessageRecord.from_wire_message(TurnEnd(), timestamp=ts)
            f.write(json.dumps(end.model_dump(mode="json")) + "\n")
            ts += 1

    return wire_path


def _write_context_file(session_dir: Path, user_messages: list[str]) -> Path:
    """Write a context.jsonl with user messages and dummy assistant responses."""
    context_path = session_dir / "context.jsonl"
    with context_path.open("w", encoding="utf-8") as f:
        for text in user_messages:
            msg = Message(role="user", content=[TextPart(text=text)])
            f.write(msg.model_dump_json(exclude_none=True) + "\n")
            resp = Message(role="assistant", content="response")
            f.write(resp.model_dump_json(exclude_none=True) + "\n")
    return context_path


# ---------------------------------------------------------------------------
# Tests: _extract_user_text
# ---------------------------------------------------------------------------


class TestExtractUserText:
    def test_string_input(self):
        assert _extract_user_text("hello world") == "hello world"

    def test_content_parts(self):
        parts = [{"text": "hello"}, {"text": "world"}]
        assert _extract_user_text(parts) == "hello world"

    def test_empty_list(self):
        assert _extract_user_text([]) == ""

    def test_mixed_parts(self):
        parts = [{"text": "hello"}, {"type": "image", "source": "..."}]
        assert _extract_user_text(parts) == "hello"

    def test_string_parts_in_list(self):
        parts = ["hello", {"text": "world"}]
        assert _extract_user_text(parts) == "hello world"


# ---------------------------------------------------------------------------
# Tests: _is_checkpoint_user_message
# ---------------------------------------------------------------------------


class TestIsCheckpointUserMessage:
    def test_checkpoint_string(self):
        record = {"role": "user", "content": "<system>CHECKPOINT 0</system>"}
        assert _is_checkpoint_user_message(record) is True

    def test_checkpoint_content_part(self):
        record = {"role": "user", "content": [{"text": "<system>CHECKPOINT 3</system>"}]}
        assert _is_checkpoint_user_message(record) is True

    def test_normal_user_message(self):
        record = {"role": "user", "content": "hello"}
        assert _is_checkpoint_user_message(record) is False

    def test_assistant_message(self):
        record = {"role": "assistant", "content": "<system>CHECKPOINT 0</system>"}
        assert _is_checkpoint_user_message(record) is False


# ---------------------------------------------------------------------------
# Tests: enumerate_turns
# ---------------------------------------------------------------------------


class TestEnumerateTurns:
    def test_empty_file(self, session_dir: Path):
        assert enumerate_turns(session_dir / "wire.jsonl") == []

    def test_nonexistent_file(self, tmp_path: Path):
        assert enumerate_turns(tmp_path / "nonexistent.jsonl") == []

    def test_single_turn(self, session_dir: Path):
        _write_wire_file(session_dir, ["hello world"])
        turns = enumerate_turns(session_dir / "wire.jsonl")
        assert len(turns) == 1
        assert turns[0] == TurnInfo(index=0, user_text="hello world")

    def test_multiple_turns(self, session_dir: Path):
        _write_wire_file(session_dir, ["first", "second", "third"])
        turns = enumerate_turns(session_dir / "wire.jsonl")
        assert len(turns) == 3
        assert turns[0].index == 0
        assert turns[0].user_text == "first"
        assert turns[1].index == 1
        assert turns[1].user_text == "second"
        assert turns[2].index == 2
        assert turns[2].user_text == "third"


# ---------------------------------------------------------------------------
# Tests: truncate_wire_at_turn
# ---------------------------------------------------------------------------


class TestTruncateWireAtTurn:
    def test_truncate_at_first_turn(self, session_dir: Path):
        _write_wire_file(session_dir, ["first", "second", "third"])
        wire_path = session_dir / "wire.jsonl"
        lines = truncate_wire_at_turn(wire_path, 0)
        # metadata + TurnBegin + TurnEnd = 3 lines
        assert len(lines) == 3

    def test_truncate_at_last_turn(self, session_dir: Path):
        _write_wire_file(session_dir, ["first", "second"])
        wire_path = session_dir / "wire.jsonl"
        lines = truncate_wire_at_turn(wire_path, 1)
        # metadata + 2*(TurnBegin + TurnEnd) = 5 lines
        assert len(lines) == 5

    def test_out_of_range(self, session_dir: Path):
        _write_wire_file(session_dir, ["first"])
        wire_path = session_dir / "wire.jsonl"
        with pytest.raises(ValueError, match="out of range"):
            truncate_wire_at_turn(wire_path, 5)

    def test_nonexistent_file(self, tmp_path: Path):
        with pytest.raises(ValueError, match="wire.jsonl not found"):
            truncate_wire_at_turn(tmp_path / "wire.jsonl", 0)

    def test_preserves_metadata(self, session_dir: Path):
        _write_wire_file(session_dir, ["first"])
        wire_path = session_dir / "wire.jsonl"
        lines = truncate_wire_at_turn(wire_path, 0)
        first_record = json.loads(lines[0])
        assert first_record["type"] == "metadata"

    def test_metadata_only_no_turns(self, session_dir: Path):
        """wire.jsonl with only metadata and no turns should raise ValueError."""
        wire_path = session_dir / "wire.jsonl"
        metadata = WireFileMetadata(protocol_version=WIRE_PROTOCOL_VERSION)
        with wire_path.open("w", encoding="utf-8") as f:
            f.write(json.dumps(metadata.model_dump(mode="json")) + "\n")
        with pytest.raises(ValueError, match="out of range"):
            truncate_wire_at_turn(wire_path, 0)


# ---------------------------------------------------------------------------
# Tests: truncate_context_at_turn
# ---------------------------------------------------------------------------


class TestTruncateContextAtTurn:
    def test_truncate_at_first_turn(self, session_dir: Path):
        _write_context_file(session_dir, ["first msg", "second msg"])
        context_path = session_dir / "context.jsonl"
        lines = truncate_context_at_turn(context_path, 0)
        # first user + first assistant = 2 lines
        assert len(lines) == 2

    def test_truncate_at_last_turn(self, session_dir: Path):
        _write_context_file(session_dir, ["first", "second"])
        context_path = session_dir / "context.jsonl"
        lines = truncate_context_at_turn(context_path, 1)
        # all 4 lines
        assert len(lines) == 4

    def test_nonexistent_file(self, tmp_path: Path):
        result = truncate_context_at_turn(tmp_path / "context.jsonl", 0)
        assert result == []

    def test_skips_checkpoint_messages(self, session_dir: Path):
        context_path = session_dir / "context.jsonl"
        context_path.parent.mkdir(parents=True, exist_ok=True)
        records = [
            {"role": "user", "content": "first msg"},
            {"role": "assistant", "content": "response 1"},
            {"role": "user", "content": "<system>CHECKPOINT 0</system>"},
            {"role": "user", "content": "second msg"},
            {"role": "assistant", "content": "response 2"},
        ]
        with context_path.open("w", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

        # Turn 0 = "first msg", turn 1 = "second msg" (checkpoint skipped)
        lines = truncate_context_at_turn(context_path, 0)
        # first user + first assistant + checkpoint = 3 lines
        assert len(lines) == 3

    def test_best_effort_when_fewer_turns(self, session_dir: Path):
        _write_context_file(session_dir, ["only one"])
        context_path = session_dir / "context.jsonl"
        # Request turn_index=5 but only 1 turn exists — returns all lines
        lines = truncate_context_at_turn(context_path, 5)
        assert len(lines) == 2


# ---------------------------------------------------------------------------
# Tests: fork_session
# ---------------------------------------------------------------------------


class TestForkSession:
    async def test_fork_at_turn(self, isolated_share_dir: Path, work_dir: KaosPath):
        from kimi_cli.session import Session

        source = await Session.create(work_dir)
        _write_wire_file(source.dir, ["turn 0", "turn 1", "turn 2"])
        _write_context_file(source.dir, ["turn 0", "turn 1", "turn 2"])

        new_id = await fork_session(
            source_session_dir=source.dir,
            work_dir=work_dir,
            turn_index=1,
            title_prefix="Undo",
            source_title="My Session",
        )

        # Verify new session exists
        new_session = await Session.find(work_dir, new_id)
        assert new_session is not None

        # Verify wire was truncated
        wire_lines = (
            (new_session.dir / "wire.jsonl").read_text(encoding="utf-8").strip().split("\n")
        )
        # metadata + 2 turns * (TurnBegin + TurnEnd) = 5
        assert len(wire_lines) == 5

        # Verify context was truncated
        ctx_lines = (
            (new_session.dir / "context.jsonl").read_text(encoding="utf-8").strip().split("\n")
        )
        # 2 turns * (user + assistant) = 4
        assert len(ctx_lines) == 4

    async def test_fork_all_turns(self, isolated_share_dir: Path, work_dir: KaosPath):
        from kimi_cli.session import Session

        source = await Session.create(work_dir)
        _write_wire_file(source.dir, ["turn 0", "turn 1"])
        _write_context_file(source.dir, ["turn 0", "turn 1"])

        new_id = await fork_session(
            source_session_dir=source.dir,
            work_dir=work_dir,
            turn_index=None,
            title_prefix="Fork",
            source_title="My Session",
        )

        new_session = await Session.find(work_dir, new_id)
        assert new_session is not None

        wire_lines = (
            (new_session.dir / "wire.jsonl").read_text(encoding="utf-8").strip().split("\n")
        )
        # metadata + 2*(TurnBegin + TurnEnd) = 5
        assert len(wire_lines) == 5

    async def test_fork_sets_title(self, isolated_share_dir: Path, work_dir: KaosPath):
        from kimi_cli.session import Session
        from kimi_cli.session_state import load_session_state

        source = await Session.create(work_dir)
        _write_wire_file(source.dir, ["hello"])
        _write_context_file(source.dir, ["hello"])

        new_id = await fork_session(
            source_session_dir=source.dir,
            work_dir=work_dir,
            turn_index=0,
            title_prefix="Undo",
            source_title="Original Title",
        )

        new_session = await Session.find(work_dir, new_id)
        assert new_session is not None
        state = load_session_state(new_session.dir)
        assert state.custom_title == "Undo: Original Title"

    async def test_fork_reads_title_from_state(self, isolated_share_dir: Path, work_dir: KaosPath):
        """When source_title is None, fork_session reads title from session state."""
        from kimi_cli.session import Session
        from kimi_cli.session_state import load_session_state, save_session_state

        source = await Session.create(work_dir)
        _write_wire_file(source.dir, ["hello"])
        _write_context_file(source.dir, ["hello"])

        # Set a custom title on the source session
        src_state = load_session_state(source.dir)
        src_state.custom_title = "Custom Source Title"
        save_session_state(src_state, source.dir)

        new_id = await fork_session(
            source_session_dir=source.dir,
            work_dir=work_dir,
            turn_index=0,
            title_prefix="Fork",
            # source_title not passed — should read from state
        )

        new_session = await Session.find(work_dir, new_id)
        assert new_session is not None
        state = load_session_state(new_session.dir)
        assert state.custom_title == "Fork: Custom Source Title"

    async def test_fork_copies_referenced_videos(
        self, isolated_share_dir: Path, work_dir: KaosPath
    ):
        from kimi_cli.session import Session

        source = await Session.create(work_dir)

        # Create a fake video file
        uploads = source.dir / "uploads"
        uploads.mkdir()
        (uploads / "test.mp4").write_text("fake video")

        # Write wire that references the video
        wire_path = source.dir / "wire.jsonl"
        metadata = WireFileMetadata(protocol_version=WIRE_PROTOCOL_VERSION)
        ts = time.time()
        begin = WireMessageRecord.from_wire_message(
            TurnBegin(user_input="look at uploads/test.mp4"),
            timestamp=ts,
        )
        end = WireMessageRecord.from_wire_message(TurnEnd(), timestamp=ts)
        with wire_path.open("w", encoding="utf-8") as f:
            f.write(json.dumps(metadata.model_dump(mode="json")) + "\n")
            f.write(json.dumps(begin.model_dump(mode="json")) + "\n")
            f.write(json.dumps(end.model_dump(mode="json")) + "\n")

        _write_context_file(source.dir, ["look at video"])

        new_id = await fork_session(
            source_session_dir=source.dir,
            work_dir=work_dir,
            turn_index=0,
            source_title="Video Session",
        )

        new_session = await Session.find(work_dir, new_id)
        assert new_session is not None
        new_video = new_session.dir / "uploads" / "test.mp4"
        assert new_video.exists()
        assert new_video.read_text() == "fake video"

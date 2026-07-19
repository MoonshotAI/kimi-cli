"""Tests for upload re-send prevention across server restarts (#2413).

``SessionProcess._encode_uploaded_files`` must persist which uploads were
already sent, so a restarted ``kimi web`` server does not attach previously
sent files to the next prompt again.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from kosong.message import ContentPart

import kimi_cli.web.runner.process as process_module
from kimi_cli.web.runner.process import SessionProcess


@pytest.fixture
def session_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fake session dir with one uploaded text file, wired into the module."""
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "notes.txt").write_text("hello upload", encoding="utf-8")

    session = MagicMock()
    session.kimi_cli_session.dir = tmp_path
    monkeypatch.setattr(process_module, "load_session_by_id", lambda _id: session)

    config = MagicMock()
    config.default_model = None
    monkeypatch.setattr(process_module, "load_config", lambda: config)
    return tmp_path


async def _encode(sp: SessionProcess) -> list[ContentPart]:
    return [part async for part in sp._encode_uploaded_files()]


async def test_sent_files_marker_persisted_to_disk(session_dir: Path) -> None:
    """After encoding, the .sent marker must record the sent file names."""
    sp = SessionProcess(uuid4())
    parts = await _encode(sp)
    assert any("notes.txt" in getattr(p, "text", "") for p in parts)

    marker = session_dir / "uploads" / ".sent"
    assert marker.exists()
    assert json.loads(marker.read_text(encoding="utf-8")) == ["notes.txt"]


async def test_restarted_process_does_not_resend_uploads(session_dir: Path) -> None:
    """A new SessionProcess (server restart) must not re-encode sent uploads."""
    first = SessionProcess(uuid4())
    parts = await _encode(first)
    assert parts, "first prompt should include the uploaded file"

    restarted = SessionProcess(uuid4())
    assert await _encode(restarted) == []


async def test_new_upload_after_restart_is_sent_once(session_dir: Path) -> None:
    """Files added after a restart are sent, previously sent ones are not."""
    first = SessionProcess(uuid4())
    await _encode(first)

    (session_dir / "uploads" / "later.txt").write_text("second", encoding="utf-8")
    restarted = SessionProcess(uuid4())
    parts = await _encode(restarted)
    texts = [getattr(p, "text", "") for p in parts]
    assert any("later.txt" in t for t in texts)
    assert not any("notes.txt" in t for t in texts)

    marker = session_dir / "uploads" / ".sent"
    assert json.loads(marker.read_text(encoding="utf-8")) == ["later.txt", "notes.txt"]

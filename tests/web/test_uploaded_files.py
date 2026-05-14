"""Tests for web runner upload handling."""

from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from kosong.message import TextPart

from kimi_cli.web.runner import process as process_module
from kimi_cli.web.runner.process import SessionProcess


@pytest.mark.asyncio
async def test_uploaded_files_marker_survives_process_restart(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session_dir = tmp_path / "session"
    uploads = session_dir / "uploads"
    uploads.mkdir(parents=True)
    (uploads / "note.txt").write_text("hello", encoding="utf-8")

    session = SimpleNamespace(kimi_cli_session=SimpleNamespace(dir=session_dir))
    monkeypatch.setattr(process_module, "load_session_by_id", lambda _session_id: session)

    first_process = SessionProcess(uuid4())
    first_parts = [part async for part in first_process._encode_uploaded_files()]

    assert any(isinstance(part, TextPart) and "note.txt" in part.text for part in first_parts)
    assert json.loads((uploads / ".sent").read_text(encoding="utf-8")) == ["note.txt"]

    restarted_process = SessionProcess(uuid4())
    restarted_parts = [part async for part in restarted_process._encode_uploaded_files()]

    assert restarted_parts == []

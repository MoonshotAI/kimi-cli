from __future__ import annotations

import json
from pathlib import Path

from kimi_cli.runtime_status import (
    RUNTIME_STATUS_FILENAME,
    RUNTIME_STATUS_SCHEMA_VERSION,
    clear_runtime_status,
    read_runtime_status,
    write_runtime_status,
)


def test_write_runtime_status_writes_expected_fields(tmp_path: Path):
    target = write_runtime_status(
        tmp_path,
        session_id="11111111-2222-3333-4444-555555555555",
        work_dir="/work/dir",
        pid=4242,
    )
    assert target == tmp_path / RUNTIME_STATUS_FILENAME
    assert target.exists()
    data = json.loads(target.read_text(encoding="utf-8"))
    assert data["pid"] == 4242
    assert data["session_id"] == "11111111-2222-3333-4444-555555555555"
    assert data["work_dir"] == "/work/dir"
    assert data["schema_version"] == RUNTIME_STATUS_SCHEMA_VERSION
    assert isinstance(data["hostname"], str) and data["hostname"]
    assert isinstance(data["started_at"], (int, float))
    assert "kimi_version" in data  # may be None but key must be present


def test_write_runtime_status_is_atomic(tmp_path: Path):
    write_runtime_status(tmp_path, session_id="abc", work_dir="/w", pid=1)
    # No temp leftover after a successful write.
    leftovers = list(tmp_path.glob("*.tmp"))
    assert leftovers == []


def test_read_runtime_status_roundtrip(tmp_path: Path):
    write_runtime_status(
        tmp_path,
        session_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        work_dir="/some/where",
        pid=99,
    )
    status = read_runtime_status(tmp_path)
    assert status is not None
    assert status.pid == 99
    assert status.session_id == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    assert status.work_dir == "/some/where"
    assert status.schema_version == RUNTIME_STATUS_SCHEMA_VERSION


def test_read_runtime_status_missing_returns_none(tmp_path: Path):
    assert read_runtime_status(tmp_path) is None


def test_read_runtime_status_malformed_returns_none(tmp_path: Path):
    (tmp_path / RUNTIME_STATUS_FILENAME).write_text("not-json", encoding="utf-8")
    assert read_runtime_status(tmp_path) is None


def test_read_runtime_status_unknown_schema_returns_none(tmp_path: Path):
    (tmp_path / RUNTIME_STATUS_FILENAME).write_text(
        json.dumps(
            {
                "schema_version": RUNTIME_STATUS_SCHEMA_VERSION + 99,
                "pid": 1,
                "session_id": "x",
                "work_dir": "/w",
                "hostname": "h",
                "started_at": 0.0,
                "kimi_version": None,
            }
        ),
        encoding="utf-8",
    )
    assert read_runtime_status(tmp_path) is None


def test_clear_runtime_status_is_idempotent(tmp_path: Path):
    write_runtime_status(tmp_path, session_id="x", work_dir="/w", pid=1)
    assert (tmp_path / RUNTIME_STATUS_FILENAME).exists()
    clear_runtime_status(tmp_path)
    assert not (tmp_path / RUNTIME_STATUS_FILENAME).exists()
    # Second call must not raise.
    clear_runtime_status(tmp_path)


def test_clear_runtime_status_on_missing_dir_does_not_raise(tmp_path: Path):
    missing = tmp_path / "nope"
    # Calling on a directory that does not exist must not raise.
    clear_runtime_status(missing)


def test_runtime_status_roundtrip_with_non_ascii(tmp_path: Path):
    # Session ids and work-dir basenames may legitimately contain non-ASCII
    # characters (Chinese, Japanese, etc.). Verify they round-trip through the
    # file unchanged and are stored as literal UTF-8, not escaped.
    session_id = "中文-uuid-aaa"
    work_dir = "C:/项目/我的-app"
    write_runtime_status(tmp_path, session_id=session_id, work_dir=work_dir, pid=7)

    raw = (tmp_path / RUNTIME_STATUS_FILENAME).read_text(encoding="utf-8")
    # Literal characters present, not \uXXXX escapes (atomic_json_write uses
    # ensure_ascii=False).
    assert "中文-uuid-aaa" in raw
    assert "项目" in raw and "我的-app" in raw
    assert "\\u" not in raw

    status = read_runtime_status(tmp_path)
    assert status is not None
    assert status.session_id == session_id
    assert status.work_dir == work_dir


def test_write_runtime_status_no_tmp_leftover_on_failure(tmp_path: Path, monkeypatch):
    # Simulate an I/O failure during the tmp-file write and assert that the
    # exception propagates and no .tmp file is left behind.
    import os as _os

    real_fdopen = _os.fdopen

    def boom_fdopen(*args, **kwargs):
        f = real_fdopen(*args, **kwargs)
        f.close()
        raise OSError("simulated write failure")

    monkeypatch.setattr(_os, "fdopen", boom_fdopen)

    import pytest

    with pytest.raises(OSError, match="simulated write failure"):
        write_runtime_status(tmp_path, session_id="x", work_dir="/w", pid=1)

    # Final file must not exist, and no .tmp leftover either.
    assert not (tmp_path / RUNTIME_STATUS_FILENAME).exists()
    leftovers = list(tmp_path.glob("*.tmp"))
    assert leftovers == [], f"unexpected leftovers: {leftovers}"

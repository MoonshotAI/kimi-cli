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
    assert "kimi_version" in data


def test_write_runtime_status_is_atomic(tmp_path: Path):
    write_runtime_status(tmp_path, session_id="abc", work_dir="/w", pid=1)
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
    clear_runtime_status(tmp_path)


def test_clear_runtime_status_on_missing_dir_does_not_raise(tmp_path: Path):
    missing = tmp_path / "nope"
    clear_runtime_status(missing)


def test_runtime_status_preserves_chinese_chars(tmp_path: Path):
    """Path components and session ids may contain non-ASCII; the JSON
    must round-trip without mangling so external observers see the real
    values, not escaped surrogates."""
    write_runtime_status(
        tmp_path,
        session_id="\u4e2d\u6587-uuid-aaa",
        work_dir="D:/\u9879\u76ee/\u6211\u7684-app",
        pid=7777,
    )
    status = read_runtime_status(tmp_path)
    assert status is not None
    assert status.session_id == "\u4e2d\u6587-uuid-aaa"
    assert status.work_dir == "D:/\u9879\u76ee/\u6211\u7684-app"
    raw_bytes = (tmp_path / RUNTIME_STATUS_FILENAME).read_bytes()
    assert "\u4e2d\u6587".encode() in raw_bytes

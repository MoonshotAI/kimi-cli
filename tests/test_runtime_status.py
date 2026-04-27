from __future__ import annotations

import json
from pathlib import Path

import pytest

from kimi_cli import runtime_status as rs
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


def test_write_creates_pid_index_mirror(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    share = tmp_path / "share"
    monkeypatch.setenv("KIMI_SHARE_DIR", str(share))
    session_dir = tmp_path / "sess"
    session_dir.mkdir()

    rs.write_runtime_status(session_dir, session_id="abc", work_dir="/w", pid=4242)

    mirror = share / "runtime" / "4242.json"
    assert mirror.exists()
    body = json.loads(mirror.read_text(encoding="utf-8"))
    assert body["pid"] == 4242
    assert body["session_id"] == "abc"
    # Per-session and PID-keyed mirror must contain identical fields.
    perSession = json.loads((session_dir / "runtime.json").read_text(encoding="utf-8"))
    assert perSession == body


def test_clear_removes_pid_index_mirror(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    share = tmp_path / "share"
    monkeypatch.setenv("KIMI_SHARE_DIR", str(share))
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    rs.write_runtime_status(session_dir, session_id="abc", work_dir="/w", pid=4242)

    rs.clear_runtime_status(session_dir)

    assert not (session_dir / "runtime.json").exists()
    assert not (share / "runtime" / "4242.json").exists()


def test_find_runtime_status_by_pid_roundtrip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    share = tmp_path / "share"
    monkeypatch.setenv("KIMI_SHARE_DIR", str(share))
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    rs.write_runtime_status(session_dir, session_id="aaa-bbb", work_dir="C:/proj", pid=999)

    found = rs.find_runtime_status_by_pid(999)
    assert found is not None
    assert found.pid == 999
    assert found.session_id == "aaa-bbb"
    assert found.work_dir == "C:/proj"


def test_find_runtime_status_by_pid_missing_returns_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    share = tmp_path / "share"
    monkeypatch.setenv("KIMI_SHARE_DIR", str(share))
    assert rs.find_runtime_status_by_pid(123456) is None


def test_pid_index_mirror_preserves_chinese_chars(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    share = tmp_path / "share"
    monkeypatch.setenv("KIMI_SHARE_DIR", str(share))
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    rs.write_runtime_status(
        session_dir,
        session_id="\u4e2d\u6587-uuid-aaa",
        work_dir="D:/\u9879\u76ee/\u6211\u7684-app",
        pid=7777,
    )

    mirror = share / "runtime" / "7777.json"
    body = json.loads(mirror.read_text(encoding="utf-8"))
    assert body["session_id"] == "\u4e2d\u6587-uuid-aaa"
    assert body["work_dir"] == "D:/\u9879\u76ee/\u6211\u7684-app"

    found = rs.find_runtime_status_by_pid(7777)
    assert found is not None
    assert found.session_id == "\u4e2d\u6587-uuid-aaa"
    assert found.work_dir == "D:/\u9879\u76ee/\u6211\u7684-app"


def test_clear_with_explicit_pid(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    share = tmp_path / "share"
    monkeypatch.setenv("KIMI_SHARE_DIR", str(share))
    session_dir = tmp_path / "sess"
    session_dir.mkdir()
    rs.write_runtime_status(session_dir, session_id="abc", work_dir="/w", pid=5555)

    # Per-session file removed by some other path; we still want the
    # PID-keyed mirror to be cleaned up if the caller passes pid.
    (session_dir / "runtime.json").unlink()
    rs.clear_runtime_status(session_dir, pid=5555)

    assert not (share / "runtime" / "5555.json").exists()


def test_prune_stale_pid_index_removes_dead_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    share = tmp_path / "share"
    monkeypatch.setenv("KIMI_SHARE_DIR", str(share))
    pid_dir = share / "runtime"
    pid_dir.mkdir(parents=True)

    import os as _os

    live_pid = _os.getpid()
    # Use a clearly-bogus high pid that won't be allocated.
    bogus_pid = 9_999_999

    (pid_dir / f"{live_pid}.json").write_text("{}", encoding="utf-8")
    (pid_dir / f"{bogus_pid}.json").write_text("{}", encoding="utf-8")
    (pid_dir / "not-a-pid.json").write_text("{}", encoding="utf-8")
    (pid_dir / "ignored.txt").write_text("noise", encoding="utf-8")

    removed = rs.prune_stale_pid_index()

    # The bogus PID file is gone; the live one and non-pid filenames stay.
    assert not (pid_dir / f"{bogus_pid}.json").exists()
    assert (pid_dir / f"{live_pid}.json").exists()
    assert (pid_dir / "not-a-pid.json").exists()
    assert (pid_dir / "ignored.txt").exists()
    assert removed >= 1


def test_prune_stale_pid_index_when_dir_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    share = tmp_path / "share"
    monkeypatch.setenv("KIMI_SHARE_DIR", str(share))
    # No runtime/ directory created at all — must not raise, returns 0.
    assert rs.prune_stale_pid_index() == 0


def test_is_pid_alive_basic(monkeypatch: pytest.MonkeyPatch):
    import os as _os

    assert rs._is_pid_alive(_os.getpid()) is True
    assert rs._is_pid_alive(0) is False
    assert rs._is_pid_alive(-1) is False
    assert rs._is_pid_alive(9_999_999) is False

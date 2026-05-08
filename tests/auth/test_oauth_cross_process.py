"""Cross-process tests for OAuth file lock and atomic credential writes.

These tests spawn real OS subprocesses that share a temp directory, verifying
that ``_CrossProcessLock`` provides mutual exclusion and that
``_save_to_file`` never produces corrupt JSON under concurrency.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

N_WORKERS = 4
N_INCREMENTS = 10

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _spawn_workers(
    script: str,
    tmp_path: Path,
    n: int,
    *,
    timeout: float = 60.0,
) -> list[tuple[int, str, str]]:
    """Spawn *n* independent Python processes running *script*."""
    script_path = tmp_path / "_worker.py"
    script_path.write_text(script, encoding="utf-8")

    share = tmp_path / "share"
    (share / "credentials").mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["KIMI_SHARE_DIR"] = str(share)

    procs = [
        subprocess.Popen(
            [sys.executable, str(script_path), str(i)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for i in range(n)
    ]

    results: list[tuple[int, str, str]] = []
    for p in procs:
        out, err = p.communicate(timeout=timeout)
        results.append((p.returncode, out.decode(), err.decode()))
    return results


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------


def test_cross_process_lock_mutual_exclusion(tmp_path: Path) -> None:
    """Shared counter incremented under lock must have no lost updates.

    If the lock fails to serialize, concurrent read-modify-write will lose
    increments and the final count will be less than expected.
    """
    counter = tmp_path / "counter.txt"
    counter.write_text("0")

    # Each worker acquires the lock, reads the counter, increments, writes
    # back, then releases.  Repeat N_INCREMENTS times.
    script = textwrap.dedent(f"""\
        import asyncio, sys
        from pathlib import Path
        from kimi_cli.auth.oauth import _CrossProcessLock

        COUNTER = Path({str(counter)!r})
        KEY = "oauth/kimi-code"

        async def main():
            for _ in range({N_INCREMENTS}):
                lock = _CrossProcessLock(KEY)
                acquired = await lock.acquire_with_retry()
                assert acquired, "failed to acquire cross-process lock"
                try:
                    n = int(COUNTER.read_text())
                    COUNTER.write_text(str(n + 1))
                finally:
                    lock.release()

        asyncio.run(main())
    """)

    results = _spawn_workers(script, tmp_path, N_WORKERS)
    for rc, _out, err in results:
        assert rc == 0, f"Worker failed (rc={rc}):\n{err}"

    assert int(counter.read_text()) == N_WORKERS * N_INCREMENTS


def test_atomic_save_no_corruption(tmp_path: Path) -> None:
    """Concurrent ``_save_to_file`` must never produce unreadable JSON."""
    script = textwrap.dedent(f"""\
        import sys, time, json
        from pathlib import Path
        from kimi_cli.auth.oauth import OAuthToken, _save_to_file

        worker_id = int(sys.argv[1])

        for i in range({N_INCREMENTS}):
            token = OAuthToken(
                access_token=f"at-{{worker_id}}-{{i}}",
                refresh_token=f"rt-{{worker_id}}-{{i}}",
                expires_at=time.time() + 900,
                scope="kimi-code",
                token_type="Bearer",
                expires_in=900.0,
            )
            _save_to_file("kimi-code", token)

        # After all writes, the file must still be valid JSON.
        path = Path({str(tmp_path / "share" / "credentials" / "kimi-code.json")!r})
        data = json.loads(path.read_text(encoding="utf-8"))
        assert "access_token" in data and "refresh_token" in data
    """)

    results = _spawn_workers(script, tmp_path, N_WORKERS)
    for rc, _out, err in results:
        assert rc == 0, f"Worker failed:\n{err}"

    cred = tmp_path / "share" / "credentials" / "kimi-code.json"
    data = json.loads(cred.read_text(encoding="utf-8"))
    assert data["access_token"].startswith("at-")
    assert data["refresh_token"].startswith("rt-")
    # No leftover temp files
    assert list(cred.parent.glob("*.tmp")) == []


@pytest.mark.skipif(sys.platform == "win32", reason="fcntl not available on Windows")
@pytest.mark.asyncio
async def test_lock_file_created_with_safe_permissions(tmp_path: Path) -> None:
    """Lock file is created with 0o600 permissions (owner-only)."""
    from kimi_cli.auth.oauth import _CrossProcessLock

    share = tmp_path / "share"
    (share / "credentials").mkdir(parents=True, exist_ok=True)
    original = os.environ.get("KIMI_SHARE_DIR")
    os.environ["KIMI_SHARE_DIR"] = str(share)
    try:
        lock = _CrossProcessLock("oauth/kimi-code")
        acquired = await lock.acquire_with_retry()
        assert acquired
        lock_path = share / "credentials" / "kimi-code.lock"
        assert lock_path.exists()
        mode = lock_path.stat().st_mode & 0o777
        assert mode == 0o600, f"Expected 0o600, got {oct(mode)}"
        lock.release()
    finally:
        if original is None:
            os.environ.pop("KIMI_SHARE_DIR", None)
        else:
            os.environ["KIMI_SHARE_DIR"] = original

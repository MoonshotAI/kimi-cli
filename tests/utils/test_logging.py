from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from kimi_cli.utils import logging as logging_utils


def test_get_log_file_path_keeps_shared_log_off_windows(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    monkeypatch.setattr(logging_utils.sys, "platform", "linux")

    assert logging_utils.get_log_file_path() == tmp_path / "logs" / "kimi.log"


def test_get_log_file_path_uses_process_log_on_windows(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    monkeypatch.setattr(logging_utils.sys, "platform", "win32")
    monkeypatch.setattr(logging_utils.os, "getpid", lambda: 12345)

    assert logging_utils.get_log_file_path() == tmp_path / "logs" / "kimi.12345.log"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows file locking regression")
def test_windows_processes_can_rotate_logs_concurrently(tmp_path: Path):
    """Exercise Loguru's real Windows file handles in separate processes."""
    ready = tmp_path / "ready"
    release = tmp_path / "release"
    env = os.environ.copy()
    env["KIMI_SHARE_DIR"] = str(tmp_path)

    holder_code = """
import os, time
from loguru import logger
from kimi_cli.utils.logging import get_log_file_path
logger.remove()
logger.add(get_log_file_path(), rotation='1 B')
logger.info('holder')
open(os.environ['READY'], 'w').close()
while not os.path.exists(os.environ['RELEASE']):
    time.sleep(0.01)
"""
    env["READY"] = str(ready)
    env["RELEASE"] = str(release)
    holder = subprocess.Popen(
        [sys.executable, "-c", holder_code],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        for _ in range(500):
            if ready.exists():
                break
            if holder.poll() is not None:
                break
            time.sleep(0.01)
        assert ready.exists(), holder.communicate(timeout=1)[1]

        writer_code = """
from loguru import logger
from kimi_cli.utils.logging import get_log_file_path
logger.remove()
logger.add(get_log_file_path(), rotation='1 B')
logger.info('writer')
"""
        writer = subprocess.run(
            [sys.executable, "-c", writer_code],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert writer.returncode == 0
        assert "PermissionError" not in writer.stderr
        assert len(list((tmp_path / "logs").glob("kimi.*.log"))) >= 2
    finally:
        release.touch()
        holder.communicate(timeout=10)

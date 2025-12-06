"""Tests for list_directory robustness and formatting."""

from __future__ import annotations

import os

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from kimi_cli.utils.path import list_directory


@pytest.mark.asyncio
async def test_list_directory(temp_work_dir: KaosPath) -> None:
    # Create a regular file and a directory (use KaosPath async ops for style consistency)
    await (temp_work_dir / "regular.txt").write_text("hello")
    await (temp_work_dir / "adir").mkdir()
    await (temp_work_dir / "adir" / "inside.txt").write_text("world")
    await (temp_work_dir / "emptydir").mkdir()
    await (temp_work_dir / "largefile.bin").write_bytes(b"x" * 10_000_000)
    os.symlink(
        (temp_work_dir / "regular.txt").unsafe_to_local_path(),
        (temp_work_dir / "link_to_regular").unsafe_to_local_path(),
    )
    os.symlink(
        (temp_work_dir / "missing.txt").unsafe_to_local_path(),
        (temp_work_dir / "link_to_regular_missing").unsafe_to_local_path(),
    )

    out = await list_directory(temp_work_dir)
    assert out == snapshot(
        """\
-rw-r--r--          5 regular.txt
drwxr-xr-x         96 adir
drwxr-xr-x         64 emptydir
-rw-r--r--   10000000 largefile.bin
-rw-r--r--          5 link_to_regular
?---------          ? link_to_regular_missing [stat failed]\
"""
    )

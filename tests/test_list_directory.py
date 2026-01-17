"""Tests for list_directory robustness and formatting."""

from __future__ import annotations

import os
import platform

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from gitrekt_cli.utils.path import list_directory


@pytest.mark.skipif(platform.system() == "Windows", reason="Unix-specific symlink tests.")
async def test_list_directory_unix(temp_work_dir: KaosPath) -> None:
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
    out_without_size = "\n".join(
        sorted(
            line.split(maxsplit=2)[0] + " " + line.split(maxsplit=2)[2] for line in out.splitlines()
        )
    )  # Remove size for snapshot stability
    assert out_without_size == snapshot(
        """\
-rw-r--r-- largefile.bin
-rw-r--r-- link_to_regular
-rw-r--r-- regular.txt
?--------- link_to_regular_missing [stat failed]
drwxr-xr-x adir
drwxr-xr-x emptydir\
"""
    )


@pytest.mark.skipif(platform.system() != "Windows", reason="Windows-specific symlink tests.")
async def test_list_directory_windows(temp_work_dir: KaosPath) -> None:
    # Create a regular file and a directory (use KaosPath async ops for style consistency)
    await (temp_work_dir / "regular.txt").write_text("hello")
    await (temp_work_dir / "adir").mkdir()
    await (temp_work_dir / "adir" / "inside.txt").write_text("world")
    await (temp_work_dir / "emptydir").mkdir()
    await (temp_work_dir / "largefile.bin").write_bytes(b"x" * 10_000_000)

    out = await list_directory(temp_work_dir)
    assert out == snapshot("""\
drwxrwxrwx          0 adir
drwxrwxrwx          0 emptydir
-rw-rw-rw-   10000000 largefile.bin
-rw-rw-rw-          5 regular.txt\
""")

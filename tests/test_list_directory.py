"""Tests for list_directory robustness and formatting."""

from __future__ import annotations

import os
import platform
import re
from pathlib import Path

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from kimi_cli.utils.path import list_directory


@pytest.mark.skipif(platform.system() == "Windows", reason="Unix-specific symlink tests.")
@pytest.mark.asyncio
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
@pytest.mark.asyncio
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


@pytest.mark.asyncio
async def test_list_directory_basic_entries(temp_work_dir: KaosPath) -> None:
    """It lists regular files and directories without crashing and with expected format.

    We don't assert ordering (filesystem-dependent); just that entries appear and the mode/size
    placeholders are present in each line.
    """

    # Create a regular file and a directory (use KaosPath async ops for style consistency)
    await (temp_work_dir / "regular.txt").write_text("hello")
    await (temp_work_dir / "adir").mkdir()

    out = await list_directory(temp_work_dir)
    lines = out.splitlines()

    # Must contain both entries
    assert any("regular.txt" in ln and "[stat failed]" not in ln for ln in lines)
    assert any("adir" in ln and "[stat failed]" not in ln for ln in lines)

    # Each line should start with 10-char mode string like drwxr-xr-x or -rw-r--r--
    for ln in lines:
        assert re.match(r"^[\-d][r-][w-][x-][r-][w-][x-][r-][w-][x-] ", ln)


@pytest.mark.asyncio
async def test_list_directory_handles_broken_symlink(temp_work_dir: KaosPath) -> None:
    """Broken symlinks must not crash listing and should render a placeholder line."""

    # Regular file via KaosPath async API
    await (temp_work_dir / "ok.txt").write_text("x")

    # Try to create a broken symlink; skip test if not supported (e.g., Windows without perms)
    local = Path(str(temp_work_dir))
    target = local / "missing.txt"
    link = local / "broken_link"
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError) as e:  # pragma: no cover - platform dependent
        pytest.skip(f"symlink not supported: {e}")

    out = await list_directory(temp_work_dir)
    lines = out.splitlines()

    # Find the line for the broken link and validate formatting
    broken_line = next((ln for ln in lines if "broken_link" in ln), None)
    assert broken_line is not None, out
    assert broken_line.startswith("?--------- ")
    assert " [stat failed]" in broken_line
    # The size field should be a right-justified '?' (width 10)
    assert re.search(r"\?---------\s{1,}\?\s+broken_link\s+\[stat failed\]$", broken_line)

    # Regular file is still listed normally
    assert any("ok.txt" in ln and "[stat failed]" not in ln for ln in lines)

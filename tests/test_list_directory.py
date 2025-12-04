"""Tests for list_directory robustness and formatting."""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest
from kaos.path import KaosPath

from kimi_cli.utils.path import list_directory


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

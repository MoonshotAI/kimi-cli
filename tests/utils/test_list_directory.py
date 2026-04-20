"""Tests for list_directory robustness and formatting."""

from __future__ import annotations

import os
import platform

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from kimi_cli.utils.path import _LIST_DIR_CHILD_WIDTH, _LIST_DIR_ROOT_WIDTH, list_directory


@pytest.mark.skipif(platform.system() == "Windows", reason="Unix-specific symlink tests.")
async def test_list_directory_tree_unix(temp_work_dir: KaosPath) -> None:
    """Tree output with dirs-first sorting, children expanded, broken symlinks handled."""
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
├── adir/
│   └── inside.txt
├── emptydir/
├── largefile.bin
├── link_to_regular
├── link_to_regular_missing
└── regular.txt\
"""
    )


async def test_list_directory_truncates_root_width(temp_work_dir: KaosPath) -> None:
    """GH-1809: root level is capped at _LIST_DIR_ROOT_WIDTH."""
    overflow = 50
    file_count = _LIST_DIR_ROOT_WIDTH + overflow
    for i in range(file_count):
        (temp_work_dir / f"file_{i:04d}.txt").unsafe_to_local_path().touch()

    out = await list_directory(temp_work_dir)
    lines = out.splitlines()

    # ROOT_WIDTH entries + 1 truncation footer
    assert len(lines) == _LIST_DIR_ROOT_WIDTH + 1
    assert lines[-1] == f"└── ... and {overflow} more entries"


async def test_list_directory_truncates_child_width(temp_work_dir: KaosPath) -> None:
    """Children of a root directory are capped at _LIST_DIR_CHILD_WIDTH."""
    await (temp_work_dir / "subdir").mkdir()
    overflow = 5
    child_count = _LIST_DIR_CHILD_WIDTH + overflow
    for i in range(child_count):
        (temp_work_dir / "subdir" / f"child_{i:03d}.txt").unsafe_to_local_path().touch()

    out = await list_directory(temp_work_dir)
    lines = out.splitlines()

    # 1 (subdir/) + CHILD_WIDTH (children) + 1 (truncation)
    assert len(lines) == 1 + _LIST_DIR_CHILD_WIDTH + 1
    assert "subdir/" in lines[0]
    assert lines[-1] == f"    └── ... and {overflow} more"


async def test_list_directory_dirs_before_files(temp_work_dir: KaosPath) -> None:
    """Directories are sorted before files, both groups alphabetical."""
    await (temp_work_dir / "zebra.txt").write_text("z")
    await (temp_work_dir / "alpha").mkdir()
    await (temp_work_dir / "beta.txt").write_text("b")
    await (temp_work_dir / "omega").mkdir()

    out = await list_directory(temp_work_dir)
    assert out == snapshot(
        """\
├── alpha/
├── omega/
├── beta.txt
└── zebra.txt\
"""
    )


async def test_list_directory_empty(temp_work_dir: KaosPath) -> None:
    """Empty directory returns a placeholder string."""
    out = await list_directory(temp_work_dir)
    assert out == "(empty directory)"


@pytest.mark.skipif(platform.system() == "Windows", reason="Unix-specific permission tests.")
async def test_list_directory_unreadable_subdir(temp_work_dir: KaosPath) -> None:
    """Unreadable subdirectory shows [not readable] instead of crashing."""
    await (temp_work_dir / "secret").mkdir()
    await (temp_work_dir / "secret" / "file.txt").write_text("x")
    os.chmod((temp_work_dir / "secret").unsafe_to_local_path(), 0o000)
    try:
        out = await list_directory(temp_work_dir)
        assert out == snapshot(
            """\
└── secret/
    └── [not readable]\
"""
        )
    finally:
        os.chmod((temp_work_dir / "secret").unsafe_to_local_path(), 0o755)


@pytest.mark.skipif(platform.system() == "Windows", reason="Unix-specific tests.")
async def test_list_directory_last_entry_is_dir(temp_work_dir: KaosPath) -> None:
    """When the last root entry is a dir, child prefix uses spaces not │."""
    await (temp_work_dir / "only_dir").mkdir()
    await (temp_work_dir / "only_dir" / "child.txt").write_text("c")

    out = await list_directory(temp_work_dir)
    assert out == snapshot(
        """\
└── only_dir/
    └── child.txt\
"""
    )


@pytest.mark.skipif(platform.system() != "Windows", reason="Windows-specific symlink tests.")
async def test_list_directory_tree_windows(temp_work_dir: KaosPath) -> None:
    await (temp_work_dir / "regular.txt").write_text("hello")
    await (temp_work_dir / "adir").mkdir()
    await (temp_work_dir / "adir" / "inside.txt").write_text("world")
    await (temp_work_dir / "emptydir").mkdir()

    out = await list_directory(temp_work_dir)
    assert out == snapshot(
        """\
├── adir/
│   └── inside.txt
├── emptydir/
└── regular.txt\
"""
    )

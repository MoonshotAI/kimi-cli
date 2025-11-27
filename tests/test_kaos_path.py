from __future__ import annotations

import os
from pathlib import Path

import pytest

from kaos import reset_current_kaos, set_current_kaos
from kaos.local import LocalKaos
from kaos.path import KaosPath


@pytest.fixture
def kaos_cwd(tmp_path):
    """Set LocalKaos as the current Kaos and switch cwd to a temp directory."""
    token = set_current_kaos(LocalKaos())
    old_cwd = Path.cwd()
    os.chdir(tmp_path)
    try:
        yield tmp_path
    finally:
        os.chdir(old_cwd)
        reset_current_kaos(token)


def test_join_and_parent(kaos_cwd):
    base = KaosPath("folder")
    child = base / "data.txt"

    assert str(child) == str(Path("folder") / "data.txt")
    assert child.parent == KaosPath("folder")
    assert child.name == "data.txt"
    assert not child.is_absolute()


def test_home_and_cwd(kaos_cwd):
    assert str(KaosPath.home()) == str(Path.home())
    assert str(KaosPath.cwd()) == str(kaos_cwd)


def test_canonical_and_relative_to(kaos_cwd):
    canonical = KaosPath("nested/../file.txt").canonical()
    assert str(canonical) == str(Path(kaos_cwd) / "file.txt")

    base = KaosPath(str(Path(kaos_cwd) / "base"))
    child = base / "inner" / "note.txt"
    relative = child.relative_to(base)
    assert str(relative) == str(Path("inner") / "note.txt")


@pytest.mark.asyncio
async def test_exists_and_file_ops(kaos_cwd):
    file_path = KaosPath("log.txt")
    assert not await file_path.exists()

    await file_path.write_text("hello")
    assert await file_path.exists()
    assert await file_path.is_file()
    assert not await file_path.is_dir()

    await file_path.append_text("\nworld")
    assert await file_path.read_text() == "hello\nworld"

    dir_path = KaosPath("logs")
    await dir_path.mkdir()
    assert await dir_path.exists()
    assert await dir_path.is_dir()


@pytest.mark.asyncio
async def test_iterdir_and_glob_from_kaos_path(kaos_cwd):
    base_dir = KaosPath("data")
    await base_dir.mkdir()

    await (base_dir / "one.txt").write_text("1")
    await (base_dir / "two.md").write_text("2")
    await (base_dir / "three.txt").write_text("3")

    entries = [entry.name async for entry in await base_dir.iterdir()]
    assert set(entries) == {"one.txt", "two.md", "three.txt"}

    globbed = [entry.name async for entry in await base_dir.glob("*.txt")]
    assert set(globbed) == {"one.txt", "three.txt"}


@pytest.mark.asyncio
async def test_read_write_bytes(kaos_cwd):
    file_path = KaosPath("data.bin")
    await file_path.write_bytes(b"\x00\x01\xff")
    assert await file_path.read_bytes() == b"\x00\x01\xff"

from __future__ import annotations

import os
from collections.abc import Generator
from pathlib import Path, PurePosixPath, PureWindowsPath

import pytest

from kaos import reset_current_kaos, set_current_kaos
from kaos.local import LocalKaos
from kaos.path import KaosPath


@pytest.fixture
def local_kaos(tmp_path: Path) -> Generator[LocalKaos]:
    """Set LocalKaos as the current Kaos and switch cwd to a temp directory."""
    local = LocalKaos()
    token = set_current_kaos(local)
    old_cwd = Path.cwd()
    try:
        os.chdir(tmp_path)
        yield local
    finally:
        os.chdir(old_cwd)
        reset_current_kaos(token)


def test_pathclass_gethome_and_getcwd(local_kaos: LocalKaos):
    path_class = local_kaos.pathclass()
    if os.name == "nt":
        assert issubclass(path_class, PureWindowsPath)
    else:
        assert issubclass(path_class, PurePosixPath)

    assert str(local_kaos.gethome()) == str(Path.home())
    assert str(local_kaos.getcwd()) == str(Path.cwd())


@pytest.mark.asyncio
async def test_chdir_and_stat(local_kaos: LocalKaos):
    new_dir = local_kaos.getcwd() / "nested"
    await local_kaos.mkdir(new_dir)

    await local_kaos.chdir(new_dir)
    assert Path.cwd() == new_dir.unsafe_to_local_path()

    file_path = new_dir / "file.txt"
    await local_kaos.writetext(file_path, "hello world")

    stat_result = await local_kaos.stat(file_path)
    assert stat_result.st_size == len("hello world")


@pytest.mark.asyncio
async def test_iterdir_and_glob(local_kaos: LocalKaos):
    tmp_path = local_kaos.getcwd()
    await local_kaos.mkdir(tmp_path / "alpha")
    await local_kaos.writetext(tmp_path / "bravo.txt", "bravo")
    await local_kaos.writetext(tmp_path / "charlie.TXT", "charlie")

    entries = [entry async for entry in local_kaos.iterdir(tmp_path)]
    assert {entry.name for entry in entries} == {"alpha", "bravo.txt", "charlie.TXT"}
    assert all(isinstance(entry, KaosPath) for entry in entries)

    matched = [entry.name async for entry in local_kaos.glob(tmp_path, "*.txt")]
    assert set(matched) == {"bravo.txt"}


@pytest.mark.asyncio
async def test_read_write_and_append_text(local_kaos: LocalKaos):
    tmp_path = local_kaos.getcwd()
    file_path = tmp_path / "note.txt"

    written = await local_kaos.writetext(file_path, "line1")
    assert written == len("line1")

    content = await local_kaos.readtext(file_path)
    assert content == "line1"

    await local_kaos.writetext(file_path, "\nline2", mode="a")
    lines = [line async for line in local_kaos.readlines(file_path)]
    assert "".join(lines) == "line1\nline2"


@pytest.mark.asyncio
async def test_mkdir_with_parents(local_kaos: LocalKaos):
    tmp_path = local_kaos.getcwd()
    nested_dir = tmp_path / "a" / "b" / "c"

    await local_kaos.mkdir(nested_dir, parents=True)
    assert await nested_dir.is_dir()


@pytest.mark.asyncio
async def test_read_write_bytes(local_kaos: LocalKaos):
    tmp_path = local_kaos.getcwd()
    file_path = tmp_path / "data.bin"
    await local_kaos.writebytes(file_path, b"\x00\x01\xff")
    assert await local_kaos.readbytes(file_path) == b"\x00\x01\xff"

from __future__ import annotations

import os
from collections.abc import Generator
from pathlib import Path, PurePosixPath, PureWindowsPath

import pytest

from kaos import reset_current_kaos, set_current_kaos
from kaos.local import LocalKaos
from kaos.path import KaosPath


@pytest.fixture
def local_kaos(tmp_path: Path) -> Generator[tuple[LocalKaos, Path]]:
    """Set LocalKaos as the current Kaos and switch cwd to a temp directory."""
    local = LocalKaos()
    token = set_current_kaos(local)
    old_cwd = Path.cwd()
    os.chdir(tmp_path)
    try:
        yield local, tmp_path
    finally:
        os.chdir(old_cwd)
        reset_current_kaos(token)


def test_pathclass_gethome_and_getcwd(local_kaos: tuple[LocalKaos, Path]):
    local, tmp_path = local_kaos

    path_class = local.pathclass()
    if os.name == "nt":
        assert issubclass(path_class, PureWindowsPath)
    else:
        assert issubclass(path_class, PurePosixPath)

    assert str(local.gethome()) == str(Path.home())
    assert str(local.getcwd()) == str(tmp_path)


@pytest.mark.asyncio
async def test_chdir_and_stat(local_kaos: tuple[LocalKaos, Path]):
    local, tmp_path = local_kaos
    new_dir = tmp_path / "nested"
    new_dir.mkdir()

    await local.chdir(KaosPath.unsafe_from_local_path(new_dir))
    assert Path.cwd() == new_dir

    file_path = new_dir / "file.txt"
    file_path.write_text("hello world")

    stat_result = await local.stat(KaosPath.unsafe_from_local_path(file_path))
    assert stat_result.st_size == len("hello world")


@pytest.mark.asyncio
async def test_iterdir_and_glob(local_kaos: tuple[LocalKaos, Path]):
    local, tmp_path = local_kaos
    (tmp_path / "alpha").mkdir()
    (tmp_path / "bravo.txt").write_text("bravo")
    (tmp_path / "charlie.TXT").write_text("charlie")

    entries = [entry async for entry in local.iterdir(KaosPath.unsafe_from_local_path(tmp_path))]
    assert {entry.name for entry in entries} == {"alpha", "bravo.txt", "charlie.TXT"}
    assert all(isinstance(entry, KaosPath) for entry in entries)

    matched = [
        entry.name async for entry in local.glob(KaosPath.unsafe_from_local_path(tmp_path), "*.txt")
    ]
    assert set(matched) == {"bravo.txt"}


@pytest.mark.asyncio
async def test_read_write_and_append_text(local_kaos: tuple[LocalKaos, Path]):
    local, tmp_path = local_kaos
    file_path = KaosPath.unsafe_from_local_path(tmp_path / "note.txt")

    written = await local.writetext(file_path, "line1")
    assert written == len("line1")

    content = await local.readtext(file_path)
    assert content == "line1"

    await local.writetext(file_path, "\nline2", mode="a")
    lines = [line async for line in local.readlines(file_path)]
    assert "".join(lines) == "line1\nline2"


@pytest.mark.asyncio
async def test_mkdir_with_parents(local_kaos: tuple[LocalKaos, Path]):
    local, tmp_path = local_kaos
    nested_dir = tmp_path / "a" / "b" / "c"

    await local.mkdir(KaosPath.unsafe_from_local_path(nested_dir), parents=True)
    assert nested_dir.is_dir()


@pytest.mark.asyncio
async def test_read_write_bytes(local_kaos: tuple[LocalKaos, Path]):
    local, tmp_path = local_kaos
    file_path = KaosPath.unsafe_from_local_path(tmp_path / "data.bin")
    await local.writebytes(file_path, b"\x00\x01\xff")
    assert await local.readbytes(file_path) == b"\x00\x01\xff"

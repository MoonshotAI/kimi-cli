from __future__ import annotations

from pathlib import Path

from kaos import reset_current_kaos, set_current_kaos
from kaos.local import ScopedLocalKaos
from kaos.path import KaosPath

from kimi_cli.acp.kaos import ACPKaos


class _FakeACPClient:
    pass


async def test_acp_kaos_resolves_relative_paths_from_session_work_dir(tmp_path: Path) -> None:
    work_dir = tmp_path / "project"
    work_dir.mkdir()
    (work_dir / "note.txt").write_text("hello", encoding="utf-8")

    acp_kaos = ACPKaos(
        _FakeACPClient(),  # type: ignore[arg-type]
        "session-1",
        None,
        fallback=ScopedLocalKaos(str(work_dir)),
    )
    token = set_current_kaos(acp_kaos)
    try:
        assert str(KaosPath("note.txt").canonical()) == str(work_dir / "note.txt")
        assert await acp_kaos.readtext("note.txt") == "hello"
    finally:
        reset_current_kaos(token)

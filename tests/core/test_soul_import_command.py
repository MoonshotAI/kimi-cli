from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

from kimi_cli.soul import slash as soul_slash
from kimi_cli.wire.types import TextPart


async def test_import_directory_path_reports_clear_error(tmp_path: Path, monkeypatch) -> None:
    captured: list[TextPart] = []

    def fake_wire_send(message: TextPart) -> None:
        captured.append(message)

    monkeypatch.setattr(soul_slash, "wire_send", fake_wire_send)

    target_dir = tmp_path / "import-dir"
    target_dir.mkdir()

    soul = Mock()
    await soul_slash.import_context(soul, str(target_dir))  # type: ignore[reportGeneralTypeIssues]

    assert len(captured) == 1
    assert "directory" in captured[0].text.lower()
    assert "provide a file" in captured[0].text.lower()

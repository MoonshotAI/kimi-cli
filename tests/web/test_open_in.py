from __future__ import annotations

import pytest

from kimi_cli.web.api import open_in as open_in_api


@pytest.mark.anyio
async def test_open_in_supports_windows_directory(monkeypatch, tmp_path) -> None:
    calls: list[list[str]] = []

    monkeypatch.setattr(open_in_api.sys, "platform", "win32")
    monkeypatch.setattr(open_in_api, "_run_command", lambda args: calls.append(args))

    response = await open_in_api.open_in(
        open_in_api.OpenInRequest(app="finder", path=str(tmp_path))
    )

    assert response.ok is True
    assert calls == [["explorer", str(tmp_path)]]


@pytest.mark.anyio
async def test_open_in_supports_windows_file_selection(monkeypatch, tmp_path) -> None:
    calls: list[list[str]] = []
    file_path = tmp_path / "note.txt"
    file_path.write_text("hello", encoding="utf-8")

    monkeypatch.setattr(open_in_api.sys, "platform", "win32")
    monkeypatch.setattr(open_in_api, "_run_command", lambda args: calls.append(args))

    response = await open_in_api.open_in(
        open_in_api.OpenInRequest(app="finder", path=str(file_path))
    )

    assert response.ok is True
    assert calls == [["explorer", f"/select,{file_path}"]]

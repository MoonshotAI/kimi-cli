from __future__ import annotations

import pytest

from kimi_cli.web.api import open_in as open_in_api


@pytest.mark.anyio
async def test_open_in_supports_windows_directory(monkeypatch, tmp_path) -> None:
    calls: list[list[str]] = []

    monkeypatch.setattr(open_in_api.sys, "platform", "win32")
    monkeypatch.setattr(open_in_api, "_spawn_process", lambda args: calls.append(args))

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
    monkeypatch.setattr(open_in_api, "_spawn_process", lambda args: calls.append(args))

    response = await open_in_api.open_in(
        open_in_api.OpenInRequest(app="finder", path=str(file_path))
    )

    assert response.ok is True
    assert calls == [["explorer", f"/select,{file_path}"]]


@pytest.mark.anyio
async def test_open_in_offloads_sync_work_to_thread(monkeypatch, tmp_path) -> None:
    offloaded: dict[str, object] = {}

    def fake_open_in_sync(request, path, *, is_file: bool) -> None:
        offloaded["request"] = request
        offloaded["path"] = path
        offloaded["is_file"] = is_file

    async def fake_to_thread(func, *args, **kwargs):
        offloaded["func"] = func
        return func(*args, **kwargs)

    monkeypatch.setattr(open_in_api.sys, "platform", "win32")
    monkeypatch.setattr(open_in_api, "_open_in_sync", fake_open_in_sync)
    monkeypatch.setattr(open_in_api.asyncio, "to_thread", fake_to_thread)

    response = await open_in_api.open_in(
        open_in_api.OpenInRequest(app="finder", path=str(tmp_path))
    )

    assert response.ok is True
    assert offloaded["func"] is fake_open_in_sync
    assert offloaded["path"] == tmp_path.resolve()
    assert offloaded["is_file"] is False

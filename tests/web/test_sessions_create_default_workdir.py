from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from starlette.testclient import TestClient

from kimi_cli.web.app import create_app


def _build_client(monkeypatch, tmp_path: Path, startup_dir: Path) -> TestClient:
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))
    monkeypatch.chdir(startup_dir)
    app = create_app(session_token="test-token")
    client = TestClient(app)
    client.headers.update({"Authorization": "Bearer test-token"})
    return client


def test_create_session_without_work_dir_uses_startup_dir(monkeypatch, tmp_path: Path) -> None:
    startup_dir = tmp_path / "startup"
    startup_dir.mkdir()

    with _build_client(monkeypatch, tmp_path, startup_dir) as client:
        # Simulate the existing web call path where request body can be omitted.
        response = client.post("/api/sessions/")

    assert response.status_code == 200
    payload = response.json()
    assert Path(payload["work_dir"]).resolve() == startup_dir.resolve()


def test_create_session_fallbacks_to_home_when_startup_dir_invalid(monkeypatch, tmp_path: Path) -> None:
    startup_dir = tmp_path / "startup"
    startup_dir.mkdir()

    with _build_client(monkeypatch, tmp_path, startup_dir) as client:
        client.app.state.startup_dir = str(tmp_path / "missing-startup-dir")
        with patch("kimi_cli.web.api.sessions.logger") as mock_logger:
            response = client.post("/api/sessions/")

    assert response.status_code == 200
    payload = response.json()
    assert Path(payload["work_dir"]).resolve() == Path.home().resolve()
    assert mock_logger.warning.call_count >= 1
    assert any(
        call.kwargs.get("used_fallback_home") is True for call in mock_logger.info.call_args_list
    )


def test_create_session_explicit_work_dir_kept(monkeypatch, tmp_path: Path) -> None:
    startup_dir = tmp_path / "startup"
    startup_dir.mkdir()
    explicit_dir = tmp_path / "explicit"
    explicit_dir.mkdir()

    with _build_client(monkeypatch, tmp_path, startup_dir) as client:
        response = client.post("/api/sessions/", json={"work_dir": str(explicit_dir)})

    assert response.status_code == 200
    payload = response.json()
    assert Path(payload["work_dir"]).resolve() == explicit_dir.resolve()


def test_session_file_endpoint_resolves_against_created_work_dir(monkeypatch, tmp_path: Path) -> None:
    startup_dir = tmp_path / "startup"
    project_dir = startup_dir / "project"
    project_dir.mkdir(parents=True)
    expected_content = "mention target"
    (project_dir / "note.txt").write_text(expected_content, encoding="utf-8")

    with _build_client(monkeypatch, tmp_path, startup_dir) as client:
        create_response = client.post("/api/sessions/")
        assert create_response.status_code == 200
        session_id = create_response.json()["session_id"]

        file_response = client.get(f"/api/sessions/{session_id}/files/project/note.txt")

    assert file_response.status_code == 200
    assert file_response.content.decode("utf-8") == expected_content

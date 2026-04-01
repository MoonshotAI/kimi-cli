"""Tests for file listing in sessions API — PermissionError and symlink handling."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from starlette.testclient import TestClient

from kimi_cli.web.app import create_app


@pytest.fixture
def client():
    app = create_app(lan_only=False)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def session_with_work_dir(client: TestClient, tmp_path: Path):
    """Create a session pointing to tmp_path as work_dir."""
    resp = client.post("/api/sessions/", json={"work_dir": str(tmp_path)})
    assert resp.status_code == 200
    return resp.json()["session_id"], tmp_path


def test_list_dir_skips_permission_error_on_iterdir(
    client: TestClient, session_with_work_dir: tuple[str, Path]
):
    """iterdir() raising PermissionError (e.g. macOS .Trash) should not crash."""
    session_id, work_dir = session_with_work_dir

    # Create a normal file so we can verify endpoint works
    (work_dir / "hello.txt").write_text("hi")

    original_iterdir = Path.iterdir

    def patched_iterdir(self: Path):
        if self == work_dir:
            raise PermissionError("Operation not permitted")
        return original_iterdir(self)

    with patch.object(Path, "iterdir", patched_iterdir):
        resp = client.get(f"/api/sessions/{session_id}/files/")
        assert resp.status_code == 200
        data = resp.json()
        # iterdir failed on the directory, so result should be empty
        assert data == []


def test_list_dir_skips_individual_stat_error(
    client: TestClient, session_with_work_dir: tuple[str, Path]
):
    """Individual entry stat() failure should be skipped, not crash."""
    session_id, work_dir = session_with_work_dir

    (work_dir / "good.txt").write_text("ok")
    (work_dir / "bad_entry").mkdir()

    original_is_dir = Path.is_dir

    def patched_is_dir(self: Path):
        if self.name == "bad_entry":
            raise PermissionError("Operation not permitted")
        return original_is_dir(self)

    with patch.object(Path, "is_dir", patched_is_dir):
        resp = client.get(f"/api/sessions/{session_id}/files/")
        assert resp.status_code == 200
        data = resp.json()
        names = [e["name"] for e in data]
        assert "good.txt" in names
        assert "bad_entry" not in names


def test_symlink_outside_work_dir_returns_empty_listing(client: TestClient, tmp_path: Path):
    """Symlink pointing outside work_dir should return empty JSON list, not 400."""
    # Use a subdirectory as work_dir so the external dir is truly outside
    work_dir = tmp_path / "workspace"
    work_dir.mkdir()
    resp = client.post("/api/sessions/", json={"work_dir": str(work_dir)})
    assert resp.status_code == 200
    session_id = resp.json()["session_id"]

    # Create an external directory and a symlink inside work_dir pointing to it
    external_dir = tmp_path / "external"
    external_dir.mkdir()
    (external_dir / "secret.txt").write_text("secret")
    (work_dir / "linked").symlink_to(external_dir)

    # Also create a normal file to ensure the rest of the listing is unaffected
    (work_dir / "normal.txt").write_text("ok")

    # Accessing the symlink directory should return an empty listing
    resp = client.get(f"/api/sessions/{session_id}/files/linked")
    assert resp.status_code == 200
    assert resp.json() == []

    # The root listing should still include the symlink entry and the normal file
    resp = client.get(f"/api/sessions/{session_id}/files/")
    assert resp.status_code == 200
    names = [e["name"] for e in resp.json()]
    assert "normal.txt" in names
    assert "linked" in names

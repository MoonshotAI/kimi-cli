"""Tests for the /api/git/info endpoint."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kimi_cli.web.app import create_app


@pytest.fixture
def client():
    app = create_app(session_token=None, allowed_origins=[], enforce_origin=False)
    with TestClient(app) as c:
        yield c


def _run(cmd: list[str], cwd: Path) -> None:
    subprocess.run(cmd, cwd=cwd, check=True, capture_output=True)


def _git_init_with_commit(path: Path) -> None:
    _run(["git", "init", "-b", "main"], path)
    _run(["git", "config", "user.email", "test@example.com"], path)
    _run(["git", "config", "user.name", "Test"], path)
    (path / "README.md").write_text("hi\n")
    _run(["git", "add", "README.md"], path)
    _run(["git", "commit", "-m", "init"], path)


def test_non_existent_path_returns_empty(client):
    resp = client.get("/api/git/info", params={"work_dir": "/path/that/does/not/exist"})
    assert resp.status_code == 200
    data = resp.json()
    assert data == {
        "is_git_repo": False,
        "git_root": None,
        "current_branch": None,
        "branches": [],
        "head_sha": None,
    }


def test_non_git_directory_returns_empty(client, tmp_path):
    resp = client.get("/api/git/info", params={"work_dir": str(tmp_path)})
    assert resp.status_code == 200
    data = resp.json()
    assert data["is_git_repo"] is False
    assert data["git_root"] is None


def test_git_repo_with_commit(client, tmp_path):
    _git_init_with_commit(tmp_path)
    resp = client.get("/api/git/info", params={"work_dir": str(tmp_path)})
    assert resp.status_code == 200
    data = resp.json()
    assert data["is_git_repo"] is True
    assert data["git_root"] is not None
    assert data["current_branch"] == "main"
    assert data["head_sha"] is not None
    assert len(data["head_sha"]) >= 7
    assert "main" in data["branches"]


def test_git_repo_subdirectory_resolves_to_root(client, tmp_path):
    _git_init_with_commit(tmp_path)
    sub = tmp_path / "sub"
    sub.mkdir()
    resp = client.get("/api/git/info", params={"work_dir": str(sub)})
    assert resp.status_code == 200
    data = resp.json()
    assert data["is_git_repo"] is True
    assert data["git_root"] == str(tmp_path.resolve())


def test_missing_work_dir_param_returns_422(client):
    resp = client.get("/api/git/info")
    assert resp.status_code == 422

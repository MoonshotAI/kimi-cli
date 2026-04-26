"""Tests for worktree support in the web sessions API."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kimi_cli.web.app import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
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


def _worktree_list(repo: Path) -> list[str]:
    out = subprocess.run(
        ["git", "worktree", "list", "--porcelain"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [
        line.removeprefix("worktree ").strip()
        for line in out.splitlines()
        if line.startswith("worktree ")
    ]


def test_create_worktree_session_in_non_git_dir_returns_400(client, tmp_path):
    work = tmp_path / "not-a-repo"
    work.mkdir()
    resp = client.post(
        "/api/sessions/",
        json={"work_dir": str(work), "worktree": True},
    )
    assert resp.status_code == 400
    assert "git repository" in resp.json()["detail"].lower()


def test_create_worktree_session_in_git_repo_succeeds(client, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git_init_with_commit(repo)

    resp = client.post(
        "/api/sessions/",
        json={"work_dir": str(repo), "worktree": True},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["worktree_path"] is not None
    assert data["parent_repo_path"] == str(repo.resolve())
    assert Path(data["worktree_path"]).exists()
    assert data["work_dir"] == data["worktree_path"]

    worktrees = _worktree_list(repo)
    assert data["worktree_path"] in worktrees


def test_create_worktree_session_with_invalid_branch_returns_400(client, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git_init_with_commit(repo)

    resp = client.post(
        "/api/sessions/",
        json={
            "work_dir": str(repo),
            "worktree": True,
            "worktree_branch": "does-not-exist",
        },
    )
    assert resp.status_code == 400
    worktrees = _worktree_list(repo)
    assert len(worktrees) == 1


def test_create_non_worktree_session_unchanged(client, tmp_path):
    work = tmp_path / "plain"
    work.mkdir()
    resp = client.post("/api/sessions/", json={"work_dir": str(work)})
    assert resp.status_code == 200
    data = resp.json()
    assert data["worktree_path"] is None
    assert data["parent_repo_path"] is None
    assert data["work_dir"] == str(work.resolve())


def test_delete_worktree_session_removes_worktree(client, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git_init_with_commit(repo)

    create = client.post(
        "/api/sessions/",
        json={"work_dir": str(repo), "worktree": True},
    )
    assert create.status_code == 200
    session = create.json()
    worktree_path = Path(session["worktree_path"])
    session_id = session["session_id"]

    assert worktree_path.exists()

    resp = client.delete(f"/api/sessions/{session_id}")
    assert resp.status_code in (200, 204)

    assert not worktree_path.exists()
    worktrees = _worktree_list(repo)
    assert str(worktree_path) not in worktrees


@pytest.mark.parametrize(
    "bad_name",
    [
        "../escape",
        "/absolute",
        "sub/dir",
        "..",
        ".",
        "with spaces",
        "inject;rm",
    ],
)
def test_worktree_name_path_traversal_rejected(client, tmp_path, bad_name):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git_init_with_commit(repo)
    resp = client.post(
        "/api/sessions/",
        json={"work_dir": str(repo), "worktree": True, "worktree_name": bad_name},
    )
    assert resp.status_code == 400
    assert "worktree_name" in resp.json()["detail"]
    # No worktree was created outside the managed location
    worktrees = _worktree_list(repo)
    assert len(worktrees) == 1

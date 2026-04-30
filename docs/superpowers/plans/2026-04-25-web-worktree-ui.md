# Web UI Worktree Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing CLI git-worktree feature through the web UI so users can create worktree-backed sessions from the new-session dialog, see which sessions are worktree-backed, and have worktrees automatically removed on session delete.

**Architecture:** Backend adds one new endpoint (`GET /api/git/info`) and extends `POST /api/sessions/` with worktree options, reusing the existing `src/kimi_cli/worktree.py` primitives. The `Session` response gains `worktree_path` / `parent_repo_path` fields surfaced from `SessionState`. Frontend adds a two-step `CreateSessionDialog` flow (path → worktree config), a `useGitInfo` hook that debounces the git probe, a `GitBranch` sidebar indicator, session-info rows, and a delete-confirmation warning. All color styling uses existing theme tokens (`muted-foreground`, `destructive`, `border`, `popover`, etc.).

**Tech Stack:** Python 3.12 / FastAPI / pydantic v2 (backend), React 19 / TypeScript / Tailwind / shadcn-ui (frontend), vitest (frontend tests), pytest (backend tests), OpenAPI-generated client (`web/scripts/generate-api.sh`).

**Spec:** `docs/superpowers/specs/2026-04-25-web-worktree-ui-design.md`

---

## File Structure

**New files:**
- `src/kimi_cli/web/api/git.py` — FastAPI router for `/api/git/info`.
- `tests/test_web_api_git_info.py` — backend tests for the git-info endpoint.
- `tests/test_web_worktree_sessions.py` — backend tests for worktree create + delete flows.
- `web/src/hooks/useGitInfo.ts` — React hook for debounced git-info probing.
- `web/src/hooks/useGitInfo.test.ts` — vitest for the hook.
- `web/src/features/sessions/worktree-config-step.tsx` — step-2 form extracted into its own component for testability.
- `web/src/features/sessions/create-session-dialog.test.tsx` — vitest for dialog two-step flow.

**Modified files:**
- `src/kimi_cli/web/api/__init__.py` — export the new `git_router`.
- `src/kimi_cli/web/app.py` — register the new router.
- `src/kimi_cli/web/api/sessions.py` — extend `CreateSessionRequest`, wire worktree creation into `create_session`, switch `delete_session` to `Session.delete()`.
- `src/kimi_cli/web/models.py` — add `worktree_path` / `parent_repo_path` to the `Session` model.
- `src/kimi_cli/web/store/sessions.py` — populate the two new fields in `_build_joint_session`.
- `web/src/hooks/useSessions.ts` — extend `createSession` signature, map `worktree_path` fields in session-loading paths.
- `web/src/features/sessions/create-session-dialog.tsx` — add step-2 flow wiring.
- `web/src/features/sessions/sessions.tsx` — add `GitBranch` indicator, `worktreePath` on `SessionSummary`, delete-dialog warning.
- `web/src/features/chat/components/session-info-popover.tsx` — add Worktree + Parent repo rows.
- `web/src/App.tsx` — thread options bag through `createSession` callers.

**Regenerated (not hand-edited):**
- `web/src/lib/api/models/*` and `web/src/lib/api/apis/*` — regenerate via `web/scripts/generate-api.sh` after backend changes.

---

## Task 1: Backend — extend `Session` model with worktree fields

**Files:**
- Modify: `src/kimi_cli/web/models.py`
- Modify: `src/kimi_cli/web/store/sessions.py:168-180`

Context: the `Session` response currently lacks worktree metadata. The `SessionState` already persists `worktree_path` / `parent_repo_path` (landed in commit `1886a8fb`); this task just surfaces them in the API response.

- [ ] **Step 1: Add fields to `Session`**

Edit `src/kimi_cli/web/models.py`. Find the `Session` class and add the two fields after `archived`:

```python
class Session(BaseModel):
    """Web UI session metadata."""

    session_id: UUID = Field(..., description="Session unique ID")
    title: str = Field(..., description="Session title derived from kimi-cli history")
    last_updated: datetime = Field(..., description="Last updated timestamp")
    is_running: bool = Field(default=False, description="Whether the session is running")
    status: SessionStatus | None = Field(default=None, description="Session runtime status")
    work_dir: str | None = Field(default=None, description="Working directory for the session")
    session_dir: str | None = Field(default=None, description="Session directory path")
    archived: bool = Field(default=False, description="Whether the session is archived")
    worktree_path: str | None = Field(
        default=None,
        description="Absolute path to this session's git worktree, if any",
    )
    parent_repo_path: str | None = Field(
        default=None,
        description="Absolute path to the parent git repository root, if worktree-backed",
    )
```

- [ ] **Step 2: Populate fields in `_build_joint_session`**

Edit `src/kimi_cli/web/store/sessions.py`. Update the `JointSession(...)` construction in `_build_joint_session` (around line 170) to pass the two new fields from `SessionState`:

```python
def _build_joint_session(entry: SessionIndexEntry) -> JointSession:
    kimi_session = _build_kimi_session(entry)
    return JointSession(
        session_id=entry.session_id,
        title=entry.title,
        last_updated=entry.last_updated,
        is_running=False,
        status=None,
        work_dir=entry.work_dir,
        session_dir=str(entry.session_dir),
        kimi_cli_session=kimi_session,
        archived=entry.state.archived,
        worktree_path=entry.state.worktree_path,
        parent_repo_path=entry.state.parent_repo_path,
    )
```

- [ ] **Step 3: Verify import / type-check passes**

Run:

```bash
cd /Users/barry/kimi-cli && uv run python -c "from kimi_cli.web.models import Session; s = Session(session_id='00000000-0000-0000-0000-000000000001', title='t', last_updated='2026-04-25T00:00:00Z'); assert s.worktree_path is None; assert s.parent_repo_path is None; print('ok')"
```

Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
cd /Users/barry/kimi-cli && git add src/kimi_cli/web/models.py src/kimi_cli/web/store/sessions.py && git commit -m "feat(web): surface worktree_path/parent_repo_path on Session model"
```

---

## Task 2: Backend — `GET /api/git/info` endpoint (TDD)

**Files:**
- Create: `src/kimi_cli/web/api/git.py`
- Create: `tests/test_web_api_git_info.py`
- Modify: `src/kimi_cli/web/api/__init__.py`
- Modify: `src/kimi_cli/web/app.py`

Context: the frontend needs a way to probe a path to (a) decide whether to show the worktree toggle and (b) populate the base-branch list. A single endpoint returns both pieces.

- [ ] **Step 1: Write failing tests**

Create `tests/test_web_api_git_info.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/barry/kimi-cli && uv run pytest tests/test_web_api_git_info.py -v
```

Expected: all tests fail with 404 (endpoint does not exist yet).

- [ ] **Step 3: Create the router**

Create `src/kimi_cli/web/api/git.py`:

```python
"""Git info API routes."""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from kimi_cli.utils.subprocess_env import get_clean_env

router = APIRouter(prefix="/api/git", tags=["git"])

_GIT_TIMEOUT = 5.0


class GitInfo(BaseModel):
    """Lightweight git probe response for the web UI."""

    is_git_repo: bool = Field(..., description="Whether work_dir is inside a git repository")
    git_root: str | None = Field(default=None, description="Canonical git repository root")
    current_branch: str | None = Field(default=None, description="Current branch, None if detached")
    branches: list[str] = Field(default_factory=list, description="Local branch names")
    head_sha: str | None = Field(default=None, description="Short SHA of HEAD, None if no commits")


_EMPTY = GitInfo(is_git_repo=False)


async def _git(args: list[str], cwd: Path) -> tuple[str, int]:
    """Run a git command, return (stripped stdout, exit_code).

    Returns ("", 1) on timeout or any exception.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            *args,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=get_clean_env(),
        )
        stdout_bytes, _ = await asyncio.wait_for(proc.communicate(), timeout=_GIT_TIMEOUT)
        return stdout_bytes.decode("utf-8", errors="replace").strip(), proc.returncode or 0
    except (TimeoutError, OSError):
        return "", 1


@router.get("/info", summary="Probe a directory for git info", response_model=GitInfo)
async def get_git_info(work_dir: str) -> GitInfo:
    """Return git repo info for the given work_dir."""
    try:
        path = Path(work_dir).expanduser().resolve()
    except (OSError, RuntimeError):
        return _EMPTY

    if not path.exists() or not path.is_dir():
        return _EMPTY

    root_stdout, root_code = await _git(["rev-parse", "--show-toplevel"], path)
    if root_code != 0 or not root_stdout:
        return _EMPTY

    git_root = str(Path(root_stdout).resolve())
    root_path = Path(git_root)

    branch_stdout, branch_code = await _git(
        ["symbolic-ref", "--quiet", "--short", "HEAD"], root_path
    )
    current_branch: str | None = branch_stdout if branch_code == 0 and branch_stdout else None

    head_stdout, head_code = await _git(["rev-parse", "--short", "HEAD"], root_path)
    head_sha: str | None = head_stdout if head_code == 0 and head_stdout else None

    branches_stdout, branches_code = await _git(
        ["branch", "--format=%(refname:short)"], root_path
    )
    branches: list[str] = (
        [line.strip() for line in branches_stdout.splitlines() if line.strip()]
        if branches_code == 0
        else []
    )

    return GitInfo(
        is_git_repo=True,
        git_root=git_root,
        current_branch=current_branch,
        branches=branches,
        head_sha=head_sha,
    )
```

- [ ] **Step 4: Export the router**

Edit `src/kimi_cli/web/api/__init__.py`:

```python
"""API routes."""

from kimi_cli.web.api import config, git, open_in, sessions

config_router = config.router
git_router = git.router
sessions_router = sessions.router
work_dirs_router = sessions.work_dirs_router
open_in_router = open_in.router

__all__ = [
    "config_router",
    "git_router",
    "open_in_router",
    "sessions_router",
    "work_dirs_router",
]
```

- [ ] **Step 5: Register the router on the app**

Edit `src/kimi_cli/web/app.py`. Update the import block (around line 29) to include `git_router`:

```python
from kimi_cli.web.api import (
    config_router,
    git_router,
    open_in_router,
    sessions_router,
    work_dirs_router,
)
```

Then add `application.include_router(git_router)` right after `application.include_router(sessions_router)` (around line 203):

```python
    application.include_router(config_router)
    application.include_router(sessions_router)
    application.include_router(git_router)
    application.include_router(work_dirs_router)
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/barry/kimi-cli && uv run pytest tests/test_web_api_git_info.py -v
```

Expected: all 5 tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/barry/kimi-cli && git add src/kimi_cli/web/api/git.py src/kimi_cli/web/api/__init__.py src/kimi_cli/web/app.py tests/test_web_api_git_info.py && git commit -m "feat(web): add GET /api/git/info endpoint for worktree picker"
```

---

## Task 3: Backend — extend `POST /api/sessions/` with worktree options (TDD)

**Files:**
- Modify: `src/kimi_cli/web/api/sessions.py:298-361` (create), `src/kimi_cli/web/api/sessions.py:564-583` (delete), `src/kimi_cli/web/api/sessions.py:357-362` (request model)
- Create: `tests/test_web_worktree_sessions.py`

Context: the CLI flow (in `src/kimi_cli/cli/__init__.py`) does `find_git_root` → `create_worktree` → `KimiCLISession.create` → persist worktree state. The web endpoint needs the same sequence behind a request flag. A failure after worktree creation must remove the worktree to avoid orphans.

- [ ] **Step 1: Write failing tests**

Create `tests/test_web_worktree_sessions.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/barry/kimi-cli && uv run pytest tests/test_web_worktree_sessions.py -v
```

Expected: all tests fail (endpoint ignores `worktree=True`, delete does not reap worktrees).

- [ ] **Step 3: Extend `CreateSessionRequest`**

Edit `src/kimi_cli/web/api/sessions.py`. Find the `CreateSessionRequest` class (around line 357) and add the worktree fields:

```python
class CreateSessionRequest(BaseModel):
    """Create session request."""

    work_dir: str | None = None
    create_dir: bool = False  # Whether to auto-create directory if it does not exist
    worktree: bool = False
    worktree_branch: str | None = None
    worktree_name: str | None = None
```

- [ ] **Step 4: Wire worktree creation into `create_session`**

Edit `src/kimi_cli/web/api/sessions.py`. Replace the body of `create_session` (starting around line 298) with:

```python
@router.post("/", summary="Create a new session")
async def create_session(request: CreateSessionRequest | None = None) -> Session:
    """Create a new session."""
    if request and request.work_dir:
        work_dir_path = Path(request.work_dir).expanduser().resolve()
        if not work_dir_path.exists():
            if request.create_dir:
                try:
                    work_dir_path.mkdir(parents=True, exist_ok=True)
                except PermissionError as e:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=f"Permission denied: cannot create directory {request.work_dir}",
                    ) from e
                except OSError as e:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Failed to create directory: {e}",
                    ) from e
            else:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Directory does not exist: {request.work_dir}",
                )
        if not work_dir_path.is_dir():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Path is not a directory: {request.work_dir}",
            )
        work_dir = KaosPath.unsafe_from_local_path(work_dir_path)
    else:
        work_dir = KaosPath.unsafe_from_local_path(Path.home())

    parent_repo_path: KaosPath | None = None
    worktree_path: KaosPath | None = None
    if request and request.worktree:
        from kimi_cli.worktree import WorktreeError, create_worktree, find_git_root

        parent_repo_path = await find_git_root(work_dir)
        if parent_repo_path is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Selected directory is not inside a git repository",
            )
        try:
            worktree_path = await create_worktree(
                parent_repo_path,
                name=request.worktree_name,
                branch=request.worktree_branch,
            )
        except WorktreeError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(e),
            ) from e
        work_dir = worktree_path

    try:
        kimi_cli_session = await KimiCLISession.create(work_dir=work_dir)
        if worktree_path is not None and parent_repo_path is not None:
            kimi_cli_session.state.worktree_path = str(worktree_path)
            kimi_cli_session.state.parent_repo_path = str(parent_repo_path)
            kimi_cli_session.save_state()
    except Exception:
        if worktree_path is not None and parent_repo_path is not None:
            from kimi_cli.worktree import remove_worktree

            try:
                await remove_worktree(parent_repo_path, worktree_path)
            except Exception:
                logger.exception(
                    "Failed to clean up worktree {p} after session-create error",
                    p=worktree_path,
                )
        raise

    context_file = kimi_cli_session.dir / "context.jsonl"
    invalidate_sessions_cache()
    invalidate_work_dirs_cache()
    return Session(
        session_id=UUID(kimi_cli_session.id),
        title=kimi_cli_session.title,
        last_updated=datetime.fromtimestamp(context_file.stat().st_mtime, tz=UTC),
        is_running=False,
        status=SessionStatus(
            session_id=UUID(kimi_cli_session.id),
            state="stopped",
            seq=0,
            worker_id=None,
            reason=None,
            detail=None,
            updated_at=datetime.now(UTC),
        ),
        work_dir=str(work_dir),
        session_dir=str(kimi_cli_session.dir),
        worktree_path=str(worktree_path) if worktree_path is not None else None,
        parent_repo_path=str(parent_repo_path) if parent_repo_path is not None else None,
    )
```

- [ ] **Step 5: Switch `delete_session` to `Session.delete()`**

Edit `src/kimi_cli/web/api/sessions.py`. Replace the body of `delete_session` (around line 564):

```python
@router.delete("/{session_id}", summary="Delete a session")
async def delete_session(session_id: UUID, runner: KimiCLIRunner = Depends(get_runner)) -> None:
    """Delete a session."""
    session = get_editable_session(session_id, runner)
    session_process = runner.get_session(session_id)
    if session_process is not None:
        await session_process.stop()
    wd_meta = session.kimi_cli_session.work_dir_meta
    if wd_meta.last_session_id == str(session_id):
        metadata = load_metadata()
        for wd in metadata.work_dirs:
            if wd.path == wd_meta.path:
                wd.last_session_id = None
                break
        save_metadata(metadata)
    await session.kimi_cli_session.delete()
    invalidate_sessions_cache()
```

The `shutil` import at the top of the file may become unused — leave it if it's used elsewhere; if it is no longer referenced, remove it.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/barry/kimi-cli && uv run pytest tests/test_web_worktree_sessions.py -v
```

Expected: all 5 tests pass.

- [ ] **Step 7: Run the full backend test suite to catch regressions**

```bash
cd /Users/barry/kimi-cli && uv run pytest tests/ -x -q
```

Expected: no new failures from this feature.

- [ ] **Step 8: Commit**

```bash
cd /Users/barry/kimi-cli && git add src/kimi_cli/web/api/sessions.py tests/test_web_worktree_sessions.py && git commit -m "feat(web): support worktree creation in POST /api/sessions and cleanup on delete"
```

---

## Task 4: Regenerate the OpenAPI client

**Files:**
- Modify: `web/src/lib/api/**` (regenerated)
- Modify: `web/openapi.json` (regenerated)

Context: the backend now has a new endpoint and two new response fields. The frontend client is generated from `/openapi.json` via `web/scripts/generate-api.sh`.

- [ ] **Step 1: Start the backend in one terminal**

```bash
cd /Users/barry/kimi-cli && uv run ikimi web --port 5494
```

Leave it running.

- [ ] **Step 2: Run the generator in another terminal**

```bash
cd /Users/barry/kimi-cli/web && ./scripts/generate-api.sh
```

Expected: script completes without errors. `web/src/lib/api/models/Session.ts` now includes `worktreePath` and `parentRepoPath`. `web/src/lib/api/apis/` gains a `GitApi.ts` with the new endpoint.

- [ ] **Step 3: Stop the backend**

Ctrl-C the uvicorn process.

- [ ] **Step 4: Verify generated types**

```bash
cd /Users/barry/kimi-cli/web && grep -l 'worktreePath' src/lib/api/models/Session.ts
```

Expected: path prints.

- [ ] **Step 5: Commit**

```bash
cd /Users/barry/kimi-cli && git add web/openapi.json web/src/lib/api && git commit -m "chore(web): regenerate API client for worktree endpoints"
```

---

## Task 5: Frontend — `useGitInfo` hook (TDD)

**Files:**
- Create: `web/src/hooks/useGitInfo.ts`
- Create: `web/src/hooks/useGitInfo.test.ts`

Context: the dialog needs to call `/api/git/info` whenever the user selects a path, debounced so the endpoint is not hit on every keystroke. The hook handles cancellation, loading state, and graceful fetch-error degradation.

- [ ] **Step 1: Write failing tests**

Create `web/src/hooks/useGitInfo.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useGitInfo } from "./useGitInfo";

describe("useGitInfo", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("returns null gitInfo when workDir is null", () => {
    const { result } = renderHook(() => useGitInfo(null));
    expect(result.current.gitInfo).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("fetches git info after debounce when workDir is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        is_git_repo: true,
        git_root: "/repo",
        current_branch: "main",
        branches: ["main"],
        head_sha: "abc1234",
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { result } = renderHook(() => useGitInfo("/repo"));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    await waitFor(() => {
      expect(result.current.gitInfo).not.toBeNull();
    });

    expect(result.current.gitInfo?.isGitRepo).toBe(true);
    expect(result.current.gitInfo?.currentBranch).toBe("main");
    expect(result.current.gitInfo?.branches).toEqual(["main"]);
    expect(result.current.isLoading).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("cancels in-flight request when workDir changes", async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      return new Promise(() => {
        // never resolves
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { rerender } = renderHook(
      ({ dir }: { dir: string }) => useGitInfo(dir),
      { initialProps: { dir: "/first" } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/first");

    rerender({ dir: "/second" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("/second");
  });

  it("degrades gracefully when fetch rejects", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;

    const { result } = renderHook(() => useGitInfo("/repo"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.gitInfo).toEqual({
      isGitRepo: false,
      gitRoot: null,
      currentBranch: null,
      branches: [],
      headSha: null,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/barry/kimi-cli/web && npx vitest run src/hooks/useGitInfo.test.ts
```

Expected: tests fail with "Cannot find module './useGitInfo'".

- [ ] **Step 3: Implement the hook**

Create `web/src/hooks/useGitInfo.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import { getAuthHeader } from "../lib/auth";
import { getApiBaseUrl } from "./utils";

export type GitInfo = {
  isGitRepo: boolean;
  gitRoot: string | null;
  currentBranch: string | null;
  branches: string[];
  headSha: string | null;
};

const EMPTY_GIT_INFO: GitInfo = {
  isGitRepo: false,
  gitRoot: null,
  currentBranch: null,
  branches: [],
  headSha: null,
};

const DEBOUNCE_MS = 250;

export function useGitInfo(workDir: string | null): {
  gitInfo: GitInfo | null;
  isLoading: boolean;
} {
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!workDir) {
      abortRef.current?.abort();
      abortRef.current = null;
      setGitInfo(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const timer = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const basePath = getApiBaseUrl();
      const params = new URLSearchParams({ work_dir: workDir });
      fetch(`${basePath}/api/git/info?${params}`, {
        headers: getAuthHeader(),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (controller.signal.aborted) return;
          setGitInfo({
            isGitRepo: Boolean(data.is_git_repo),
            gitRoot: data.git_root ?? null,
            currentBranch: data.current_branch ?? null,
            branches: Array.isArray(data.branches) ? data.branches : [],
            headSha: data.head_sha ?? null,
          });
        })
        .catch((err) => {
          if ((err as { name?: string }).name === "AbortError") return;
          setGitInfo(EMPTY_GIT_INFO);
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [workDir]);

  return { gitInfo, isLoading };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/barry/kimi-cli/web && npx vitest run src/hooks/useGitInfo.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/barry/kimi-cli && git add web/src/hooks/useGitInfo.ts web/src/hooks/useGitInfo.test.ts && git commit -m "feat(web): add useGitInfo hook for debounced git-info probing"
```

---

## Task 6: Frontend — `WorktreeConfigStep` component (TDD)

**Files:**
- Create: `web/src/features/sessions/worktree-config-step.tsx`
- Create: `web/src/features/sessions/worktree-config-step.test.tsx`

Context: step 2 of the dialog. Extracting it into its own component keeps `create-session-dialog.tsx` manageable and makes the form directly testable. Uses existing shadcn primitives (`Switch`, `Select`, `Input`, `Button`) and theme tokens.

- [ ] **Step 1: Write failing tests**

Create `web/src/features/sessions/worktree-config-step.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { WorktreeConfigStep } from "./worktree-config-step";

const gitInfo = {
  isGitRepo: true,
  gitRoot: "/repo",
  currentBranch: "main",
  branches: ["main", "feature/x"],
  headSha: "abc1234",
};

describe("WorktreeConfigStep", () => {
  it("renders workDir in header and toggle is off by default", () => {
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
        submitting={false}
        submitError={null}
      />,
    );
    expect(screen.getByText(/\/repo/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /isolated git worktree/i })).not.toBeChecked();
  });

  it("enables branch select when toggle is on", () => {
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
        submitting={false}
        submitError={null}
      />,
    );
    const toggle = screen.getByRole("switch", { name: /isolated git worktree/i });
    expect(screen.getByRole("combobox", { name: /base branch/i })).toBeDisabled();

    fireEvent.click(toggle);
    expect(screen.getByRole("combobox", { name: /base branch/i })).toBeEnabled();
  });

  it("calls onSubmit with disabled options when toggle off", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
        submitError={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      enabled: false,
      branch: null,
      name: null,
    });
  });

  it("calls onSubmit with enabled options when toggle on", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
        submitError={null}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: /isolated git worktree/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.enabled).toBe(true);
    expect(arg.branch).toBeNull();
  });

  it("renders submitError inline", () => {
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
        submitting={false}
        submitError="Branch not found"
      />,
    );
    expect(screen.getByText(/branch not found/i)).toBeInTheDocument();
  });

  it("calls onBack when back button clicked", () => {
    const onBack = vi.fn();
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={onBack}
        onSubmit={vi.fn()}
        submitting={false}
        submitError={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/barry/kimi-cli/web && npx vitest run src/features/sessions/worktree-config-step.test.tsx
```

Expected: tests fail with missing module.

- [ ] **Step 3: Implement the component**

Create `web/src/features/sessions/worktree-config-step.tsx`:

```tsx
import { type ReactElement, useMemo, useState } from "react";
import { ArrowLeft, GitBranch, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { GitInfo } from "@/hooks/useGitInfo";

export type WorktreeOptions = {
  enabled: boolean;
  branch: string | null;
  name: string | null;
};

const DETACHED_VALUE = "__detached__";
const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

type Props = {
  workDir: string;
  gitInfo: GitInfo;
  isLoading: boolean;
  submitting: boolean;
  submitError: string | null;
  onBack: () => void;
  onSubmit: (options: WorktreeOptions) => Promise<void> | void;
};

function autoNamePreview(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getUTCFullYear();
  const m = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mm = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  return `kimi-${y}${m}${d}-${hh}${mm}${ss}`;
}

export function WorktreeConfigStep({
  workDir,
  gitInfo,
  isLoading,
  submitting,
  submitError,
  onBack,
  onSubmit,
}: Props): ReactElement {
  const [enabled, setEnabled] = useState(false);
  const [branchValue, setBranchValue] = useState<string>(DETACHED_VALUE);
  const [name, setName] = useState("");

  const branches = useMemo(() => {
    const all = [...gitInfo.branches];
    const current = gitInfo.currentBranch;
    if (current) {
      const rest = all.filter((b) => b !== current);
      return [current, ...rest];
    }
    return all;
  }, [gitInfo.branches, gitInfo.currentBranch]);

  const namePreview = useMemo(() => autoNamePreview(), []);
  const nameInvalid = name !== "" && !NAME_REGEX.test(name);

  const handleSubmit = () => {
    if (submitting) return;
    const options: WorktreeOptions = enabled
      ? {
          enabled: true,
          branch: branchValue === DETACHED_VALUE ? null : branchValue,
          name: name.trim() || null,
        }
      : { enabled: false, branch: null, name: null };
    void onSubmit(options);
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <button
          type="button"
          aria-label="Back to directory selection"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
        </button>
        <span className="truncate text-sm font-medium text-foreground">
          New session in <span className="font-mono text-muted-foreground">{workDir}</span>
        </span>
      </div>

      <div className="flex flex-col gap-4 px-4 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <label
              className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground"
              htmlFor="worktree-toggle"
            >
              <GitBranch className="size-4" />
              Create isolated git worktree
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              Runs the session in its own detached git worktree so file changes stay isolated.
              {isLoading && (
                <>
                  {" "}
                  <Loader2 className="inline size-3 animate-spin" />
                </>
              )}
            </p>
          </div>
          <Switch
            id="worktree-toggle"
            aria-label="Create isolated git worktree"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={isLoading}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="worktree-branch" className="text-xs font-medium text-foreground">
            Base branch
          </label>
          <Select value={branchValue} onValueChange={setBranchValue} disabled={!enabled}>
            <SelectTrigger id="worktree-branch" aria-label="Base branch" className="disabled:opacity-50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DETACHED_VALUE}>
                <span className="text-foreground">Detached HEAD</span>
                {gitInfo.headSha && (
                  <span className="ml-2 text-muted-foreground">at {gitInfo.headSha}</span>
                )}
              </SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch} value={branch}>
                  <span>{branch}</span>
                  {branch === gitInfo.currentBranch && (
                    <span className="ml-2 text-muted-foreground">(current)</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="worktree-name" className="text-xs font-medium text-foreground">
            Worktree name <span className="text-muted-foreground">(optional)</span>
          </label>
          <Input
            id="worktree-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={namePreview}
            disabled={!enabled}
            className="disabled:opacity-50"
          />
          {nameInvalid && (
            <p className="text-xs text-destructive">
              Use only letters, digits, dot, underscore, and dash.
            </p>
          )}
        </div>

        {submitError && (
          <div className="flex items-start gap-2 text-xs text-destructive">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span>{submitError}</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button variant="outline" onClick={onBack} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={submitting || nameInvalid || isLoading}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          Create
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/barry/kimi-cli/web && npx vitest run src/features/sessions/worktree-config-step.test.tsx
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/barry/kimi-cli && git add web/src/features/sessions/worktree-config-step.tsx web/src/features/sessions/worktree-config-step.test.tsx && git commit -m "feat(web): add WorktreeConfigStep component for new-session dialog"
```

---

## Task 7: Frontend — wire two-step flow into `CreateSessionDialog`

**Files:**
- Modify: `web/src/features/sessions/create-session-dialog.tsx`
- Create: `web/src/features/sessions/create-session-dialog.test.tsx`

Context: the existing dialog picks a path and calls `onConfirm(path, createDir?)`. We widen the shape so step 2 can pass worktree options, and branch into step 2 when the selected path is a git repo. For non-git paths, behavior is unchanged.

- [ ] **Step 1: Write failing tests**

Create `web/src/features/sessions/create-session-dialog.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CreateSessionDialog } from "./create-session-dialog";

describe("CreateSessionDialog two-step flow", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("skips step 2 for non-git paths", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        is_git_repo: false,
        git_root: null,
        current_branch: null,
        branches: [],
        head_sha: null,
      }),
    }) as unknown as typeof fetch;

    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateSessionDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
        fetchWorkDirs={async () => []}
        fetchStartupDir={async () => "/home/user"}
      />,
    );

    const input = await screen.findByPlaceholderText(/search directories/i);
    fireEvent.change(input, { target: { value: "/tmp/not-a-repo" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledWith("/tmp/not-a-repo", undefined);
    expect(screen.queryByText(/isolated git worktree/i)).not.toBeInTheDocument();
  });

  it("shows step 2 for git repo paths", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        is_git_repo: true,
        git_root: "/repo",
        current_branch: "main",
        branches: ["main"],
        head_sha: "abc1234",
      }),
    }) as unknown as typeof fetch;

    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateSessionDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
        fetchWorkDirs={async () => []}
        fetchStartupDir={async () => ""}
      />,
    );

    const input = await screen.findByPlaceholderText(/search directories/i);
    fireEvent.change(input, { target: { value: "/repo" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await screen.findByText(/isolated git worktree/i);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/barry/kimi-cli/web && npx vitest run src/features/sessions/create-session-dialog.test.tsx
```

Expected: tests fail (current dialog knows nothing about step 2).

- [ ] **Step 3: Update imports and props type**

Edit `web/src/features/sessions/create-session-dialog.tsx`. Add imports near the top:

```tsx
import { useGitInfo } from "@/hooks/useGitInfo";
import {
  WorktreeConfigStep,
  type WorktreeOptions,
} from "./worktree-config-step";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
```

Update the `CreateSessionDialogProps` type:

```tsx
type CreateSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (
    workDir: string,
    options?: { createDir?: boolean; worktree?: WorktreeOptions },
  ) => Promise<void>;
  fetchWorkDirs: () => Promise<string[]>;
  fetchStartupDir: () => Promise<string>;
};
```

- [ ] **Step 4: Add step-2 state and branching logic**

Inside `CreateSessionDialog`, add state and derived values after the existing `useState` block:

```tsx
  const [step, setStep] = useState<"pick" | "configure">("pick");
  const [configuredWorkDir, setConfiguredWorkDir] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { gitInfo, isLoading: isGitInfoLoading } = useGitInfo(
    step === "configure" ? configuredWorkDir : null,
  );
```

Replace the existing `handleSelect` callback with:

```tsx
  const handleSelect = useCallback(
    async (dir: string) => {
      if (isCreatingRef.current) return;
      setConfiguredWorkDir(dir);
      setStep("configure");
      setSubmitError(null);
    },
    [],
  );
```

Add an effect that short-circuits step 2 for non-git paths:

```tsx
  useEffect(() => {
    if (step !== "configure" || configuredWorkDir == null || isGitInfoLoading) {
      return;
    }
    if (!gitInfo?.isGitRepo) {
      if (isCreatingRef.current) return;
      isCreatingRef.current = true;
      setIsCreating(true);
      onConfirm(configuredWorkDir, undefined)
        .then(() => {
          onOpenChange(false);
        })
        .catch((err) => {
          if (
            err instanceof Error &&
            "isDirectoryNotFound" in err &&
            (err as Error & { isDirectoryNotFound: boolean }).isDirectoryNotFound
          ) {
            setPendingPath(configuredWorkDir);
            setShowConfirmCreate(true);
            setStep("pick");
          }
        })
        .finally(() => {
          setIsCreating(false);
          isCreatingRef.current = false;
        });
    }
  }, [step, configuredWorkDir, gitInfo, isGitInfoLoading, onConfirm, onOpenChange]);
```

Add submit + back handlers:

```tsx
  const handleWorktreeSubmit = useCallback(
    async (options: WorktreeOptions) => {
      if (configuredWorkDir == null) return;
      isCreatingRef.current = true;
      setIsCreating(true);
      setSubmitError(null);
      try {
        await onConfirm(configuredWorkDir, {
          worktree: options.enabled ? options : undefined,
        });
        onOpenChange(false);
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "Failed to create session");
      } finally {
        setIsCreating(false);
        isCreatingRef.current = false;
      }
    },
    [configuredWorkDir, onConfirm, onOpenChange],
  );

  const handleBackToPick = useCallback(() => {
    setStep("pick");
    setConfiguredWorkDir(null);
    setSubmitError(null);
  }, []);
```

Extend the existing close-effect reset (around line 137) to also clear step-2 state:

```tsx
  useEffect(() => {
    if (!open) {
      setInputValue("");
      setCommandValue("");
      setWorkDirs(cachedWorkDirs ?? []);
      setIsCreating(false);
      setShowConfirmCreate(false);
      setPendingPath("");
      setStartupDir("");
      setStep("pick");
      setConfiguredWorkDir(null);
      setSubmitError(null);
      isCreatingRef.current = false;
    }
  }, [open]);
```

- [ ] **Step 5: Render step 2 conditionally**

Replace the outer JSX return. The current return is a fragment wrapping `<CommandDialog>` and `<AlertDialog>`. Change the top-level shape to:

```tsx
  return (
    <>
      {step === "configure" && configuredWorkDir != null && gitInfo?.isGitRepo ? (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="p-0 sm:max-w-lg" showCloseButton={false}>
            <WorktreeConfigStep
              workDir={configuredWorkDir}
              gitInfo={gitInfo}
              isLoading={isGitInfoLoading}
              submitting={isCreating}
              submitError={submitError}
              onBack={handleBackToPick}
              onSubmit={handleWorktreeSubmit}
            />
          </DialogContent>
        </Dialog>
      ) : (
        <CommandDialog
          open={open}
          onOpenChange={onOpenChange}
          title="Create New Session"
          description="Search directories or type a new path"
          showCloseButton={false}
        >
          {/* existing <Command>…</Command> block unchanged */}
        </CommandDialog>
      )}

      <AlertDialog open={showConfirmCreate} onOpenChange={setShowConfirmCreate}>
        {/* existing alert-dialog unchanged */}
      </AlertDialog>
    </>
  );
```

- [ ] **Step 6: Run dialog tests**

```bash
cd /Users/barry/kimi-cli/web && npx vitest run src/features/sessions/create-session-dialog.test.tsx
```

Expected: both tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/barry/kimi-cli && git add web/src/features/sessions/create-session-dialog.tsx web/src/features/sessions/create-session-dialog.test.tsx && git commit -m "feat(web): add worktree config step to CreateSessionDialog"
```

---

## Task 8: Frontend — update `useSessions.createSession` signature

**Files:**
- Modify: `web/src/hooks/useSessions.ts:59` (type), `web/src/hooks/useSessions.ts:416-490` (impl), `web/src/hooks/useSessions.ts:244-295` (mappings)
- Modify: `web/src/App.tsx` (lines ~298-308 onConfirm)

Context: forward the new options bag from the dialog through the create endpoint, and map `worktree_path` / `parent_repo_path` into the `Session` type on all manual-fetch read paths. Paths that go through the generated `apiClient` pick up the fields automatically after the Task 4 regen.

- [ ] **Step 1: Extend the hook return type**

Edit `web/src/hooks/useSessions.ts`. Import the options type at the top:

```ts
import type { WorktreeOptions } from "../features/sessions/worktree-config-step";
```

Update the `createSession` signature in `UseSessionsReturn` (line 59):

```ts
  /** Create a new session */
  createSession: (
    workDir?: string,
    options?: { createDir?: boolean; worktree?: WorktreeOptions },
  ) => Promise<Session>;
```

- [ ] **Step 2: Update the `createSession` implementation**

Edit `web/src/hooks/useSessions.ts`. Replace the signature and body-builder block of `createSession` (starts line 416):

```ts
  const createSession = useCallback(
    async (
      workDir?: string,
      options?: { createDir?: boolean; worktree?: WorktreeOptions },
    ): Promise<Session> => {
      setIsLoading(true);
      setError(null);
      try {
        const basePath = getApiBaseUrl();
        const body: {
          work_dir?: string;
          create_dir?: boolean;
          worktree?: boolean;
          worktree_branch?: string | null;
          worktree_name?: string | null;
        } = {};
        if (workDir) {
          body.work_dir = workDir;
        }
        if (options?.createDir) {
          body.create_dir = options.createDir;
        }
        if (options?.worktree?.enabled) {
          body.worktree = true;
          body.worktree_branch = options.worktree.branch;
          body.worktree_name = options.worktree.name;
        }
        const response = await fetch(`${basePath}/api/sessions/`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeader(),
          },
          body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
        });
        // rest of function (error handling, SessionFromJSON, setSessions, return) unchanged
```

- [ ] **Step 3: Map worktree fields in archived-sessions readers**

Edit `web/src/hooks/useSessions.ts`. Find the `data.map(...)` for archived sessions (around line 244) and add two fields:

```ts
      const archivedList: Session[] = data.map(
        (item: Record<string, unknown>) => ({
          sessionId: item.session_id,
          title: item.title,
          lastUpdated: new Date(item.last_updated as string),
          isRunning: item.is_running,
          status: item.status,
          workDir: item.work_dir,
          sessionDir: item.session_dir,
          archived: item.archived,
          worktreePath: item.worktree_path ?? null,
          parentRepoPath: item.parent_repo_path ?? null,
        }),
      );
```

Apply the same two lines to the second mapping block around line 286 (`loadMoreArchivedSessions`).

- [ ] **Step 4: Forward options through `App.tsx`**

Edit `web/src/App.tsx`. Import the type at the top:

```tsx
import type { WorktreeOptions } from "./features/sessions/worktree-config-step";
```

Update the dialog `onConfirm` handler (around line 298). Replace:

```tsx
    async (workDir: string, createDir?: boolean) => {
      await createSession(workDir, createDir);
    },
```

with:

```tsx
    async (
      workDir: string,
      options?: { createDir?: boolean; worktree?: WorktreeOptions },
    ) => {
      await createSession(workDir, options);
    },
```

Leave the "create-in-dir" group handler (around line 305) unchanged — it passes no options.

- [ ] **Step 5: Run the TypeScript check**

```bash
cd /Users/barry/kimi-cli/web && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 6: Run the frontend test suite**

```bash
cd /Users/barry/kimi-cli/web && npx vitest run
```

Expected: all tests pass (existing + 4 useGitInfo + 6 worktree-config-step + 2 create-session-dialog).

- [ ] **Step 7: Commit**

```bash
cd /Users/barry/kimi-cli && git add web/src/hooks/useSessions.ts web/src/App.tsx && git commit -m "feat(web): thread worktree options through createSession call sites"
```

---

## Task 9: Frontend — sidebar `GitBranch` indicator

**Files:**
- Modify: `web/src/features/sessions/sessions.tsx`
- Modify: `web/src/App.tsx`

Context: when a session is worktree-backed, show a small branch icon next to the running indicator. Uses `text-muted-foreground` so it reads as secondary metadata.

- [ ] **Step 1: Add `worktreePath` to `SessionSummary` type**

Edit `web/src/features/sessions/sessions.tsx`. Update the `SessionSummary` type (around line 63):

```tsx
type SessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  workDir?: string | null;
  lastUpdated: Date;
  isRunning?: boolean;
  worktreePath?: string | null;
};
```

- [ ] **Step 2: Import `GitBranch`**

Update the lucide-react import block:

```tsx
import {
  Plus,
  Trash2,
  Search,
  X,
  AlertTriangle,
  RefreshCw,
  List,
  FolderTree,
  ChevronDown,
  Pencil,
  Loader2,
  Archive,
  ArchiveRestore,
  CheckSquare,
  Square,
  PanelLeftClose,
  GitBranch,
} from "lucide-react";
```

- [ ] **Step 3: Render the icon in the list view**

In `sessions.tsx`, find the list-view `itemContent` block where `<SessionRunningIndicator />` renders (around line 1053). Update that div:

```tsx
                          <div className="flex items-center gap-1.5">
                            {session.isRunning && <SessionRunningIndicator />}
                            {session.worktreePath && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <GitBranch className="size-3 shrink-0 text-muted-foreground" />
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  Worktree · {shortenPath(session.worktreePath)}
                                </TooltipContent>
                              </Tooltip>
                            )}
                            <Tooltip delayDuration={500}>
                              {/* existing title tooltip unchanged */}
                            </Tooltip>
```

- [ ] **Step 4: Render the icon in the grouped view**

In `sessions.tsx`, find the grouped view's equivalent (around line 930 — inside the `Collapsible` `CollapsibleContent`, the `{session.isRunning && <SessionRunningIndicator />}` line). Add the same `{session.worktreePath && ...}` tooltip block right after it.

- [ ] **Step 5: Map `worktreePath` when building `SessionSummary` in App.tsx**

Edit `web/src/App.tsx`. The conversion from API `Session` → `SessionSummary` happens around line 344. Add `worktreePath: session.worktreePath` to each mapper (both non-archived and archived summaries, around lines 344 and 360):

```tsx
  const sessionSummaries: SessionSummary[] = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.sessionId,
        title: session.title,
        updatedAt: formatRelativeTime(session.lastUpdated),
        workDir: session.workDir,
        lastUpdated: session.lastUpdated,
        isRunning:
          session.status?.state === "idle" || session.status?.state === "busy",
        worktreePath: session.worktreePath,
      })),
    [sessions],
  );
```

(If the exact mapping shape differs in the current file, keep everything else and add just the `worktreePath:` line.)

- [ ] **Step 6: Manual smoke check**

```bash
cd /Users/barry/kimi-cli && uv run ikimi web --port 5494
```

In a browser: create a session in a git repo with the worktree toggle on. Confirm the sidebar row shows a `GitBranch` icon; hover to confirm the tooltip shows `Worktree · ...`. Stop the server.

- [ ] **Step 7: Commit**

```bash
cd /Users/barry/kimi-cli && git add web/src/features/sessions/sessions.tsx web/src/App.tsx && git commit -m "feat(web): show GitBranch indicator on worktree-backed sessions"
```

---

## Task 10: Frontend — session-info popover rows

**Files:**
- Modify: `web/src/features/chat/components/session-info-popover.tsx`

Context: when a session has a worktree, show the worktree path and parent repo path in the session info popover.

- [ ] **Step 1: Render the new rows**

Edit `web/src/features/chat/components/session-info-popover.tsx`. Find both places where `<SessionInfoItem label="Working Directory" ...>` appears (around lines 78 and 117). Extend each block:

```tsx
      {session?.workDir && (
        <SessionInfoItem label="Working Directory" value={session.workDir} />
      )}
      {session?.worktreePath && (
        <SessionInfoItem label="Worktree" value={session.worktreePath} />
      )}
      {session?.parentRepoPath && (
        <SessionInfoItem label="Parent Repository" value={session.parentRepoPath} />
      )}
      {session?.sessionDir && (
        <SessionInfoItem label="Session Directory" value={session.sessionDir} />
      )}
```

Apply the same change to both render sites (popover and tooltip paths) so the information surfaces in both UI entry points.

- [ ] **Step 2: Type-check**

```bash
cd /Users/barry/kimi-cli/web && npx tsc --noEmit
```

Expected: no new errors. `Session.worktreePath` / `Session.parentRepoPath` come from the regenerated model.

- [ ] **Step 3: Commit**

```bash
cd /Users/barry/kimi-cli && git add web/src/features/chat/components/session-info-popover.tsx && git commit -m "feat(web): show worktree + parent repo paths in session info popover"
```

---

## Task 11: Frontend — delete-confirmation warning

**Files:**
- Modify: `web/src/features/sessions/sessions.tsx`

Context: when the session being deleted owns a worktree, warn about uncommitted-work loss before the user confirms.

- [ ] **Step 1: Extend `deleteConfirm` state**

Edit `web/src/features/sessions/sessions.tsx`. Update the `deleteConfirm` state declaration (around line 197):

```tsx
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    sessionId: string;
    sessionTitle: string;
    worktreePath: string | null;
  }>({
    open: false,
    sessionId: "",
    sessionTitle: "",
    worktreePath: null,
  });
```

- [ ] **Step 2: Populate and clear the new field**

Update `openDeleteConfirm` (around line 464):

```tsx
  const openDeleteConfirm = useCallback(
    (session?: SessionSummary) => {
      if (!session) return;
      setDeleteConfirm({
        open: true,
        sessionId: session.id,
        sessionTitle: normalizeTitle(session.title ?? "Unknown Session"),
        worktreePath: session.worktreePath ?? null,
      });
    },
    [normalizeTitle],
  );
```

Update `handleCancelDelete` (around line 485) and `handleConfirmDelete` so both reset `worktreePath: null` alongside the other fields.

- [ ] **Step 3: Add a small basename helper**

Near the top of the file (after `shortenPath`), add:

```tsx
function worktreeBasename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
```

- [ ] **Step 4: Render the warning inside the delete dialog**

Find the `<DialogDescription>` in the delete confirm dialog (around line 1251). Add the warning block right after `</DialogHeader>`:

```tsx
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-5" />
              Delete Session
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <strong className="text-foreground">{deleteConfirm.sessionTitle}</strong>?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteConfirm.worktreePath && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
              <span>
                This session's git worktree (
                <code className="font-mono">{worktreeBasename(deleteConfirm.worktreePath)}</code>
                ) will also be removed. Any uncommitted work in the worktree will be lost.
              </span>
            </div>
          )}
```

- [ ] **Step 5: Manual smoke test**

Start the backend (`uv run ikimi web --port 5494`), create a worktree session, then click delete. Confirm the destructive warning box appears with the worktree directory name. Confirm deleting removes the worktree on disk (check `<repo>/.kimi/worktrees/`).

- [ ] **Step 6: Commit**

```bash
cd /Users/barry/kimi-cli && git add web/src/features/sessions/sessions.tsx && git commit -m "feat(web): warn about worktree removal in delete-session dialog"
```

---

## Task 12: End-to-end verification

**Files:** none modified; verification only.

- [ ] **Step 1: Run the full backend test suite**

```bash
cd /Users/barry/kimi-cli && uv run pytest tests/ -x -q
```

Expected: no failures attributable to this feature.

- [ ] **Step 2: Run the full frontend test suite**

```bash
cd /Users/barry/kimi-cli/web && npx vitest run
```

Expected: all tests pass, including the new suites.

- [ ] **Step 3: Build the frontend**

```bash
cd /Users/barry/kimi-cli/web && npm run build
```

Expected: build succeeds without type errors.

- [ ] **Step 4: Manual smoke test**

```bash
cd /Users/barry/kimi-cli && uv run ikimi web --port 5494
```

In a browser, in a real git repo:

1. Click "+" to open the new-session dialog.
2. Enter a path to a non-git directory — confirm it skips step 2 and creates the session.
3. Delete that session; confirm it removes cleanly.
4. Click "+" again, enter a path to a git repo — confirm step 2 appears with:
   - Toggle off by default.
   - Branch select defaults to "Detached HEAD at <sha>".
   - Branch select shows the repo's branches; current branch has `(current)` suffix.
   - Name input is disabled until toggle is on.
5. Turn the toggle on, pick a branch, submit. Confirm:
   - Session opens with `<repo>/.kimi/worktrees/kimi-<timestamp>` as CWD.
   - Sidebar row shows the `GitBranch` icon with tooltip.
   - Session info popover shows Worktree + Parent Repository rows.
6. Delete that session — the confirm dialog shows the destructive warning. After confirming, the worktree directory is gone and `git worktree list` no longer references it.
7. Error paths:
   - Submit with a nonexistent branch (via devtools POST to `/api/sessions/` with `worktree_branch: "does-not-exist"`) — confirm inline error.
   - Submit with a duplicate `worktree_name` twice — confirm inline error.

- [ ] **Step 5: If verification surfaces issues, fix and re-run**

Stop the server. Fix any regressions and re-run steps 1-4 until all pass. No commit unless a bug fix is required.

---

## Self-review checklist

**Spec coverage:** Every section of the spec maps to a task — backend endpoint (Task 2), worktree-backed create (Task 3), delete cleanup (Task 3), response fields (Task 1), generated client (Task 4), `useGitInfo` hook (Task 5), two-step dialog (Tasks 6-7), `useSessions.createSession` extension (Task 8), sidebar indicator (Task 9), session info rows (Task 10), delete warning (Task 11), E2E (Task 12).

**No placeholders:** Every step contains concrete code. No "TODO", "implement the rest", or "handle errors" shortcuts.

**Type consistency:**
- `WorktreeOptions` defined in Task 6 with `enabled: boolean`, `branch: string | null`, `name: string | null`; reused unchanged in Tasks 7, 8.
- Backend `worktree_path` / `parent_repo_path` snake_case in Tasks 1 and 3; `worktreePath` / `parentRepoPath` camelCase on the frontend (Tasks 8-11) after codegen (Task 4).
- `GitInfo` shape (`isGitRepo`, `gitRoot`, `currentBranch`, `branches`, `headSha`) matches what `WorktreeConfigStep` consumes.

**Color tokens:** every style reference uses theme variables (`text-muted-foreground`, `text-foreground`, `text-destructive`, `border-border`, `bg-destructive/5`, `border-destructive/40`, `hover:bg-accent`) — no hardcoded colors.

**Commit cadence:** 11 commits across 12 tasks, one per logical unit. Task 12 is verification only.

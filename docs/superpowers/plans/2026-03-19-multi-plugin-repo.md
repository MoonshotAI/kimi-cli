# Multi-Plugin Repository Support — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `kimi plugin install` to install a single plugin from a git repository containing multiple plugins, by specifying a subpath in the URL.

**Architecture:** Add a pure `_parse_git_url` function that splits any supported git URL into `(clone_url, subpath)`. Modify the git branch of `_resolve_source` to use the parsed clone URL and navigate to the subpath after cloning. If no subpath and no root `plugin.json`, scan subdirectories and suggest available plugins.

**Tech Stack:** Python, typer, pytest, `urllib.parse`

**Spec:** `docs/superpowers/specs/2026-03-19-multi-plugin-repo-design.md`

---

## Chunk 1: `_parse_git_url` + tests

### Task 1: Write failing tests for `_parse_git_url`

**Files:**
- Create tests in: `tests/core/test_plugin.py` (append)

- [ ] **Step 1: Write parametrized tests for `_parse_git_url`**

Append to `tests/core/test_plugin.py`:

```python
from kimi_cli.cli.plugin import _parse_git_url


@pytest.mark.parametrize(
    "url, expected_clone, expected_subpath",
    [
        # .git URLs — no subpath
        ("https://host.com/org/repo.git", "https://host.com/org/repo.git", None),
        ("http://host.com/org/repo.git", "http://host.com/org/repo.git", None),
        # .git URLs — with subpath
        ("https://host.com/org/repo.git/my-plugin", "https://host.com/org/repo.git", "my-plugin"),
        ("https://host.com/org/repo.git/packages/my-plugin", "https://host.com/org/repo.git", "packages/my-plugin"),
        # .git URLs — trailing slash (no subpath)
        ("https://host.com/org/repo.git/", "https://host.com/org/repo.git", None),
        # SSH URLs
        ("git@github.com:org/repo.git", "git@github.com:org/repo.git", None),
        ("git@github.com:org/repo.git/my-plugin", "git@github.com:org/repo.git", "my-plugin"),
        # .github in hostname should not false-match
        ("https://github.com/my.github.io/tools.git/plugin", "https://github.com/my.github.io/tools.git", "plugin"),
        # GitHub short URLs — no subpath
        ("https://github.com/org/repo", "https://github.com/org/repo", None),
        # GitHub short URLs — with subpath
        ("https://github.com/org/repo/my-plugin", "https://github.com/org/repo", "my-plugin"),
        ("https://github.com/org/repo/packages/my-plugin", "https://github.com/org/repo", "packages/my-plugin"),
        # GitHub short URLs — trailing slash
        ("https://github.com/org/repo/", "https://github.com/org/repo", None),
        # GitHub browser URL with tree/branch
        ("https://github.com/org/repo/tree/main/my-plugin", "https://github.com/org/repo", "my-plugin"),
        ("https://github.com/org/repo/tree/develop/packages/my-plugin", "https://github.com/org/repo", "packages/my-plugin"),
        # GitLab short URLs
        ("https://gitlab.com/org/repo/my-plugin", "https://gitlab.com/org/repo", "my-plugin"),
        ("https://gitlab.com/org/repo/tree/main/my-plugin", "https://gitlab.com/org/repo", "my-plugin"),
        # Edge case: fewer than 2 path segments — returned as-is
        ("https://github.com/org", "https://github.com/org", None),
    ],
)
def test_parse_git_url(url: str, expected_clone: str, expected_subpath: str | None):
    clone_url, subpath = _parse_git_url(url)
    assert clone_url == expected_clone
    assert subpath == expected_subpath
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python -m pytest tests/core/test_plugin.py::test_parse_git_url -v`
Expected: ImportError — `_parse_git_url` does not exist yet.

### Task 2: Implement `_parse_git_url`

**Files:**
- Modify: `src/kimi_cli/cli/plugin.py` (add function before `_resolve_source`)

- [ ] **Step 3: Write `_parse_git_url`**

Add after the imports, before `_resolve_source`:

```python
def _parse_git_url(target: str) -> tuple[str, str | None]:
    """Parse a git URL into (clone_url, subpath).

    Splits .git URLs at the .git boundary. For GitHub/GitLab short URLs,
    treats the first two path segments as owner/repo and the rest as subpath.
    Strips ``tree/{branch}/`` prefixes from browser-copied URLs.
    """
    # Path 1: URL contains .git followed by / or end-of-string
    idx = target.find(".git/")
    if idx == -1 and target.endswith(".git"):
        # No subpath — entire URL is the clone URL
        return target, None
    if idx != -1:
        clone_url = target[: idx + 4]  # up to and including ".git"
        rest = target[idx + 5 :]  # after ".git/"
        subpath = rest.strip("/") or None
        return clone_url, subpath

    # Path 2: GitHub/GitLab short URL (no .git)
    from urllib.parse import urlparse

    parsed = urlparse(target)
    segments = [s for s in parsed.path.split("/") if s]
    if len(segments) < 2:
        # Not enough segments for owner/repo — return as-is
        return target, None

    owner_repo = "/".join(segments[:2])
    clone_url = f"{parsed.scheme}://{parsed.netloc}/{owner_repo}"
    rest_segments = segments[2:]

    # Strip tree/{branch}/ prefix (single-segment branch only)
    if len(rest_segments) >= 2 and rest_segments[0] == "tree":
        rest_segments = rest_segments[2:]

    subpath = "/".join(rest_segments) or None
    return clone_url, subpath
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python -m pytest tests/core/test_plugin.py::test_parse_git_url -v`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/kimi_cli/cli/plugin.py tests/core/test_plugin.py
git commit -m "feat: add _parse_git_url for multi-plugin repo URL parsing"
```

---

## Chunk 2: Modify `_resolve_source` git branch + tests

### Task 3: Write failing tests for subpath resolution in `_resolve_source`

**Files:**
- Modify: `tests/core/test_plugin.py` (append)

- [ ] **Step 6: Write tests for `_resolve_source` git subpath behavior**

These tests mock `subprocess.run` to avoid real git clones. Append to `tests/core/test_plugin.py`:

```python
from unittest.mock import patch, MagicMock


def _mock_git_clone(plugins: list[str] | None = None, root_plugin: bool = False):
    """Create a mock for subprocess.run that simulates git clone.

    Args:
        plugins: Sub-directories to create with plugin.json.
        root_plugin: Whether to put plugin.json at root.
    """
    def side_effect(cmd, **kwargs):
        # cmd = ["git", "clone", "--depth", "1", url, dest]
        dest = Path(cmd[-1])
        dest.mkdir(parents=True)
        if root_plugin:
            (dest / "plugin.json").write_text(
                json.dumps({"name": "root-plugin", "version": "1.0.0"}),
                encoding="utf-8",
            )
        for name in (plugins or []):
            sub = dest / name
            sub.mkdir(parents=True, exist_ok=True)
            (sub / "plugin.json").write_text(
                json.dumps({"name": name, "version": "1.0.0"}),
                encoding="utf-8",
            )
        result = MagicMock()
        result.returncode = 0
        result.stderr = ""
        return result
    return side_effect


def test_resolve_source_git_with_subpath(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Git URL with subpath returns the sub-directory."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with patch("subprocess.run", side_effect=_mock_git_clone(plugins=["my-plugin"])):
        source, tmp_dir = _resolve_source("https://github.com/org/repo.git/my-plugin")
    assert source.name == "my-plugin"
    assert (source / "plugin.json").exists()
    assert tmp_dir is not None


def test_resolve_source_git_subpath_not_found(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Git URL with non-existent subpath raises Exit."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with patch("subprocess.run", side_effect=_mock_git_clone(plugins=[])):
        with pytest.raises(SystemExit):
            _resolve_source("https://github.com/org/repo.git/no-such-plugin")


def test_resolve_source_git_no_subpath_suggests_plugins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    """No subpath + no root plugin.json → list available plugins."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with patch(
        "subprocess.run",
        side_effect=_mock_git_clone(plugins=["alpha", "beta"]),
    ):
        with pytest.raises(SystemExit):
            _resolve_source("https://github.com/org/repo.git")
    captured = capsys.readouterr()
    assert "alpha" in captured.err
    assert "beta" in captured.err


def test_resolve_source_git_no_subpath_root_plugin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """No subpath + root plugin.json → returns root (existing behavior)."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with patch("subprocess.run", side_effect=_mock_git_clone(root_plugin=True)):
        source, tmp_dir = _resolve_source("https://github.com/org/repo.git")
    assert (source / "plugin.json").exists()


def test_resolve_source_git_subpath_traversal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Subpath with '..' should be rejected."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with patch("subprocess.run", side_effect=_mock_git_clone(plugins=[])):
        with pytest.raises(SystemExit):
            _resolve_source("https://github.com/org/repo.git/../../etc")


def test_resolve_source_git_no_subpath_no_plugins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    """No subpath + no root plugin.json + no sub-plugins → plain error."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with patch("subprocess.run", side_effect=_mock_git_clone(plugins=[])):
        with pytest.raises(SystemExit):
            _resolve_source("https://github.com/org/repo.git")
    captured = capsys.readouterr()
    assert "No plugin.json found" in captured.err


def test_resolve_source_git_short_url_with_subpath(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """GitHub short URL with subpath (no .git) returns the sub-directory."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with patch("subprocess.run", side_effect=_mock_git_clone(plugins=["my-plugin"])):
        source, tmp_dir = _resolve_source("https://github.com/org/repo/my-plugin")
    assert source.name == "my-plugin"
    assert (source / "plugin.json").exists()
```

Note: also add import at top:
```python
from kimi_cli.cli.plugin import _parse_git_url, _resolve_source
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `uv run python -m pytest tests/core/test_plugin.py::test_resolve_source_git_with_subpath -v`
Expected: FAIL — current `_resolve_source` does not handle subpath.

### Task 4: Modify `_resolve_source` git branch

**Files:**
- Modify: `src/kimi_cli/cli/plugin.py:25-41` (git branch of `_resolve_source`)

- [ ] **Step 8: Update git URL detection guard and clone logic**

Replace the git branch in `_resolve_source` (lines 25-41):

```python
    # Git URL
    if target.startswith(("https://", "git@", "http://")) and (
        ".git/" in target
        or target.endswith(".git")
        or "github.com/" in target
        or "gitlab.com/" in target
    ):
        import subprocess

        clone_url, subpath = _parse_git_url(target)

        tmp = Path(tempfile.mkdtemp(prefix="kimi-plugin-"))
        typer.echo(f"Cloning {clone_url}...")
        result = subprocess.run(
            ["git", "clone", "--depth", "1", clone_url, str(tmp / "repo")],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            shutil.rmtree(tmp, ignore_errors=True)
            typer.echo(f"Error: git clone failed: {result.stderr.strip()}", err=True)
            raise typer.Exit(1)

        repo_root = tmp / "repo"

        if subpath:
            source = (repo_root / subpath).resolve()
            if not source.is_relative_to(repo_root.resolve()):
                shutil.rmtree(tmp, ignore_errors=True)
                typer.echo(f"Error: subpath escapes repository: {subpath}", err=True)
                raise typer.Exit(1)
            if not source.is_dir():
                shutil.rmtree(tmp, ignore_errors=True)
                typer.echo(f"Error: subpath '{subpath}' not found in repository", err=True)
                raise typer.Exit(1)
            if not (source / "plugin.json").exists():
                shutil.rmtree(tmp, ignore_errors=True)
                typer.echo(f"Error: no plugin.json in '{subpath}'", err=True)
                raise typer.Exit(1)
            return source, tmp

        # No subpath — check root first
        if (repo_root / "plugin.json").exists():
            return repo_root, tmp

        # Scan one level for available plugins
        available = sorted(
            d.name
            for d in repo_root.iterdir()
            if d.is_dir() and (d / "plugin.json").exists()
        )
        if available:
            names = "\n".join(f"  - {n}" for n in available)
            typer.echo(
                f"Error: No plugin.json at repository root. "
                f"Available plugins:\n{names}\n"
                f"Use: kimi plugin install <url>/<plugin-name>",
                err=True,
            )
        else:
            typer.echo("Error: No plugin.json found in repository", err=True)
        shutil.rmtree(tmp, ignore_errors=True)
        raise typer.Exit(1)
```

- [ ] **Step 9: Run all new tests**

Run: `uv run python -m pytest tests/core/test_plugin.py -v -k "git"`
Expected: All PASS.

- [ ] **Step 10: Run full test suite**

Run: `uv run python -m pytest tests/core/test_plugin.py -v`
Expected: All PASS (no regressions).

- [ ] **Step 11: Lint + type check**

Run: `make check-kimi-cli`
Expected: Clean.

- [ ] **Step 12: Commit**

```bash
git add src/kimi_cli/cli/plugin.py tests/core/test_plugin.py
git commit -m "feat: support multi-plugin repos with subpath in git URLs"
```

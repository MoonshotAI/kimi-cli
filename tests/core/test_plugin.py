from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import typer

from kimi_cli.cli.plugin import _parse_git_url, _resolve_source
from kimi_cli.plugin import (
    PluginError,
    PluginRuntime,
    inject_config,
    parse_plugin_json,
    write_runtime,
)


def _write_plugin(tmp_path: Path, plugin_data: dict) -> Path:
    """Write a plugin.json and return the plugin directory."""
    plugin_dir = tmp_path / plugin_data.get("name", "test-plugin")
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "plugin.json").write_text(json.dumps(plugin_data), encoding="utf-8")
    return plugin_dir


def test_parse_minimal_plugin_json(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "my-plugin",
            "version": "1.0.0",
        },
    )
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert spec.name == "my-plugin"
    assert spec.version == "1.0.0"
    assert spec.config_file is None
    assert spec.inject == {}
    assert spec.runtime is None


def test_parse_full_plugin_json(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "stock-assistant",
            "version": "1.0.0",
            "description": "Stock helper",
            "config_file": "config/config.json",
            "inject": {"kimicode.api_key": "api_key"},
        },
    )
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert spec.name == "stock-assistant"
    assert spec.config_file == "config/config.json"
    assert spec.inject == {"kimicode.api_key": "api_key"}


def test_parse_plugin_json_missing_name(tmp_path: Path):
    plugin_dir = tmp_path / "bad"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text('{"version": "1.0.0"}', encoding="utf-8")
    with pytest.raises(PluginError, match="name"):
        parse_plugin_json(plugin_dir / "plugin.json")


def test_parse_plugin_json_inject_requires_config_file(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "bad-plugin",
            "version": "1.0.0",
            "inject": {"some.key": "api_key"},
        },
    )
    with pytest.raises(PluginError, match="config_file"):
        parse_plugin_json(plugin_dir / "plugin.json")


def test_parse_plugin_json_with_runtime(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "installed-plugin",
            "version": "1.0.0",
            "runtime": {"host": "kimi-code", "host_version": "1.22.0"},
        },
    )
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert spec.runtime is not None
    assert spec.runtime.host == "kimi-code"
    assert spec.runtime.host_version == "1.22.0"


def test_parse_plugin_json_missing_version(tmp_path: Path):
    plugin_dir = tmp_path / "bad"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text('{"name": "x"}', encoding="utf-8")
    with pytest.raises(PluginError, match="version"):
        parse_plugin_json(plugin_dir / "plugin.json")


def test_parse_plugin_json_malformed(tmp_path: Path):
    plugin_dir = tmp_path / "bad"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text("{not json}", encoding="utf-8")
    with pytest.raises(PluginError, match="Failed to read"):
        parse_plugin_json(plugin_dir / "plugin.json")


def test_inject_config_writes_value(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "config_file": "config/config.json",
            "inject": {"kimicode.api_key": "api_key"},
        },
    )
    config_dir = plugin_dir / "config"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(
        json.dumps({"kimicode": {"api_key": "PLACEHOLDER", "timeout": 30}}),
        encoding="utf-8",
    )

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    inject_config(plugin_dir, spec, {"api_key": "sk-real-key"})

    result = json.loads((config_dir / "config.json").read_text())
    assert result["kimicode"]["api_key"] == "sk-real-key"
    assert result["kimicode"]["timeout"] == 30  # untouched


def test_inject_config_creates_nested_path(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "config_file": "c.json",
            "inject": {"a.b.c": "api_key"},
        },
    )
    (plugin_dir / "c.json").write_text("{}", encoding="utf-8")

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    inject_config(plugin_dir, spec, {"api_key": "val"})

    result = json.loads((plugin_dir / "c.json").read_text())
    assert result["a"]["b"]["c"] == "val"


def test_inject_config_missing_key_raises(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "config_file": "c.json",
            "inject": {"x": "api_key"},
        },
    )
    (plugin_dir / "c.json").write_text("{}", encoding="utf-8")

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    with pytest.raises(PluginError, match="api_key"):
        inject_config(plugin_dir, spec, {})


def test_inject_config_missing_file_raises(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "config_file": "missing.json",
            "inject": {"x": "api_key"},
        },
    )

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    with pytest.raises(PluginError, match="not found"):
        inject_config(plugin_dir, spec, {"api_key": "v"})


def test_write_runtime(tmp_path: Path):
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
        },
    )

    runtime = PluginRuntime(host="kimi-code", host_version="1.22.0")
    write_runtime(plugin_dir, runtime)

    data = json.loads((plugin_dir / "plugin.json").read_text())
    assert data["runtime"]["host"] == "kimi-code"
    assert data["runtime"]["host_version"] == "1.22.0"
    assert data["name"] == "p"  # original fields preserved


def test_inject_config_noop_when_no_inject(tmp_path: Path):
    """inject_config should be a no-op when spec has no inject mappings."""
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
        },
    )
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    # Should not raise, even with empty values
    inject_config(plugin_dir, spec, {})


def test_inject_config_rejects_path_traversal(tmp_path: Path):
    """config_file with '..' should be rejected."""
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "config_file": "../../etc/passwd",
            "inject": {"x": "api_key"},
        },
    )
    # Create the file so it exists (the guard should trigger before reading)
    target = (plugin_dir / "../../etc/passwd").resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("{}", encoding="utf-8")

    spec = parse_plugin_json(plugin_dir / "plugin.json")
    with pytest.raises(PluginError, match="escapes plugin directory"):
        inject_config(plugin_dir, spec, {"api_key": "v"})


def test_parse_plugin_json_with_tools(tmp_path: Path):
    """Tools should be parsed from plugin.json."""
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "t",
            "version": "1.0.0",
            "tools": [
                {
                    "name": "my_tool",
                    "description": "does stuff",
                    "command": ["python3", "run.py"],
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
        },
    )
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert len(spec.tools) == 1
    assert spec.tools[0].name == "my_tool"
    assert spec.tools[0].command == ["python3", "run.py"]


def test_parse_plugin_json_ignores_unknown_fields(tmp_path: Path):
    """Unknown fields should be silently ignored (forward compat)."""
    plugin_dir = _write_plugin(
        tmp_path,
        {
            "name": "p",
            "version": "1.0.0",
            "future_field": "whatever",
        },
    )
    spec = parse_plugin_json(plugin_dir / "plugin.json")
    assert spec.name == "p"


# --- _parse_git_url tests ---


@pytest.mark.parametrize(
    "url, expected_clone, expected_subpath, expected_branch",
    [
        # .git URLs — no subpath
        ("https://host.com/org/repo.git", "https://host.com/org/repo.git", None, None),
        ("http://host.com/org/repo.git", "http://host.com/org/repo.git", None, None),
        # .git URLs — with subpath
        (
            "https://host.com/org/repo.git/my-plugin",
            "https://host.com/org/repo.git",
            "my-plugin",
            None,
        ),
        (
            "https://host.com/org/repo.git/packages/my-plugin",
            "https://host.com/org/repo.git",
            "packages/my-plugin",
            None,
        ),
        # .git URLs — trailing slash (no subpath)
        ("https://host.com/org/repo.git/", "https://host.com/org/repo.git", None, None),
        # SSH URLs
        ("git@github.com:org/repo.git", "git@github.com:org/repo.git", None, None),
        (
            "git@github.com:org/repo.git/my-plugin",
            "git@github.com:org/repo.git",
            "my-plugin",
            None,
        ),
        # .github in hostname should not false-match
        (
            "https://github.com/my.github.io/tools.git/plugin",
            "https://github.com/my.github.io/tools.git",
            "plugin",
            None,
        ),
        # GitHub short URLs — no subpath
        ("https://github.com/org/repo", "https://github.com/org/repo", None, None),
        # GitHub short URLs — with subpath
        (
            "https://github.com/org/repo/my-plugin",
            "https://github.com/org/repo",
            "my-plugin",
            None,
        ),
        (
            "https://github.com/org/repo/packages/my-plugin",
            "https://github.com/org/repo",
            "packages/my-plugin",
            None,
        ),
        # GitHub short URLs — trailing slash
        ("https://github.com/org/repo/", "https://github.com/org/repo", None, None),
        # GitHub browser URL with tree/branch — extracts branch
        (
            "https://github.com/org/repo/tree/main/my-plugin",
            "https://github.com/org/repo",
            "my-plugin",
            "main",
        ),
        (
            "https://github.com/org/repo/tree/develop/packages/my-plugin",
            "https://github.com/org/repo",
            "packages/my-plugin",
            "develop",
        ),
        # GitLab short URLs
        (
            "https://gitlab.com/org/repo/my-plugin",
            "https://gitlab.com/org/repo",
            "my-plugin",
            None,
        ),
        (
            "https://gitlab.com/org/repo/tree/main/my-plugin",
            "https://gitlab.com/org/repo",
            "my-plugin",
            "main",
        ),
        # GitLab /-/tree/ format
        (
            "https://gitlab.com/org/repo/-/tree/main/my-plugin",
            "https://gitlab.com/org/repo",
            "my-plugin",
            "main",
        ),
        # Edge case: fewer than 2 path segments — returned as-is
        ("https://github.com/org", "https://github.com/org", None, None),
    ],
)
def test_parse_git_url(
    url: str,
    expected_clone: str,
    expected_subpath: str | None,
    expected_branch: str | None,
):
    clone_url, subpath, branch = _parse_git_url(url)
    assert clone_url == expected_clone
    assert subpath == expected_subpath
    assert branch == expected_branch


# --- _resolve_source git subpath tests ---


def _mock_git_clone(plugins: list[str] | None = None, root_plugin: bool = False):
    """Create a mock for subprocess.run that simulates git clone."""

    def side_effect(cmd, **kwargs):
        dest = Path(cmd[-1])
        dest.mkdir(parents=True)
        if root_plugin:
            (dest / "plugin.json").write_text(
                json.dumps({"name": "root-plugin", "version": "1.0.0"}),
                encoding="utf-8",
            )
        for name in plugins or []:
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

    with patch(
        "subprocess.run",
        side_effect=_mock_git_clone(plugins=["my-plugin"]),
    ):
        source, tmp_dir = _resolve_source("https://github.com/org/repo.git/my-plugin")
    assert source.name == "my-plugin"
    assert (source / "plugin.json").exists()
    assert tmp_dir is not None


def test_resolve_source_git_subpath_not_found(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Git URL with non-existent subpath raises Exit."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with (
        patch("subprocess.run", side_effect=_mock_git_clone(plugins=[])),
        pytest.raises(typer.Exit),
    ):
        _resolve_source("https://github.com/org/repo.git/no-such-plugin")


def test_resolve_source_git_no_subpath_suggests_plugins(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    """No subpath + no root plugin.json -> list available plugins."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with (
        patch(
            "subprocess.run",
            side_effect=_mock_git_clone(plugins=["alpha", "beta"]),
        ),
        pytest.raises(typer.Exit),
    ):
        _resolve_source("https://github.com/org/repo.git")
    captured = capsys.readouterr()
    assert "alpha" in captured.err
    assert "beta" in captured.err


def test_resolve_source_git_no_subpath_root_plugin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """No subpath + root plugin.json -> returns root (existing behavior)."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with patch("subprocess.run", side_effect=_mock_git_clone(root_plugin=True)):
        source, _ = _resolve_source("https://github.com/org/repo.git")
    assert (source / "plugin.json").exists()


def test_resolve_source_git_subpath_traversal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Subpath with '..' should be rejected."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with (
        patch("subprocess.run", side_effect=_mock_git_clone(plugins=[])),
        pytest.raises(typer.Exit),
    ):
        _resolve_source("https://github.com/org/repo.git/../../etc")


def test_resolve_source_git_no_subpath_no_plugins(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    """No subpath + no root plugin.json + no sub-plugins -> plain error."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with (
        patch("subprocess.run", side_effect=_mock_git_clone(plugins=[])),
        pytest.raises(typer.Exit),
    ):
        _resolve_source("https://github.com/org/repo.git")
    captured = capsys.readouterr()
    assert "No plugin.json found" in captured.err


def test_resolve_source_git_short_url_with_subpath(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """GitHub short URL with subpath (no .git) returns the sub-directory."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with patch(
        "subprocess.run",
        side_effect=_mock_git_clone(plugins=["my-plugin"]),
    ):
        source, _ = _resolve_source("https://github.com/org/repo/my-plugin")
    assert source.name == "my-plugin"
    assert (source / "plugin.json").exists()


def test_resolve_source_git_tree_url_passes_branch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """tree/{branch}/ URL should pass --branch to git clone."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with patch(
        "subprocess.run",
        side_effect=_mock_git_clone(plugins=["my-plugin"]),
    ) as mock_run:
        source, _ = _resolve_source("https://github.com/org/repo/tree/develop/my-plugin")
    # Verify --branch develop was passed to git clone
    cmd = mock_run.call_args[0][0]
    assert "--branch" in cmd
    assert "develop" in cmd
    assert source.name == "my-plugin"


def test_resolve_source_git_no_branch_omits_flag(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Non-tree URL should not pass --branch to git clone."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    with patch(
        "subprocess.run",
        side_effect=_mock_git_clone(plugins=["my-plugin"]),
    ) as mock_run:
        _resolve_source("https://github.com/org/repo.git/my-plugin")
    cmd = mock_run.call_args[0][0]
    assert "--branch" not in cmd


# --- _resolve_source zip URL tests ---


def _build_plugin_zip(plugin_name: str = "my-plugin") -> bytes:
    """Build an in-memory zip containing a single plugin directory."""
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            f"{plugin_name}/plugin.json",
            json.dumps({"name": plugin_name, "version": "1.0.0"}),
        )
    return buf.getvalue()


def _patch_httpx_stream(monkeypatch: pytest.MonkeyPatch, payload: bytes) -> None:
    """Replace httpx.stream so it yields ``payload`` from a fake response."""
    import httpx

    class _FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def iter_bytes(self):
            yield payload

    class _FakeStream:
        def __enter__(self):
            return _FakeResponse()

        def __exit__(self, *exc_info):
            return False

    monkeypatch.setattr(httpx, "stream", lambda *a, **kw: _FakeStream())


def test_resolve_source_zip_url_downloads_and_extracts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """HTTP URL ending with .zip should download and extract."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    _patch_httpx_stream(monkeypatch, _build_plugin_zip("my-plugin"))

    source, tmp_dir = _resolve_source("https://example.com/my-plugin.zip")
    assert source.name == "my-plugin"
    assert (source / "plugin.json").exists()
    assert tmp_dir is not None


def test_resolve_source_zip_url_with_query_string(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """URL path ending in .zip is detected even with a query string."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    _patch_httpx_stream(monkeypatch, _build_plugin_zip("plug"))

    source, _ = _resolve_source("https://example.com/plug.zip?token=abc")
    assert source.name == "plug"


def test_resolve_source_github_archive_zip_takes_zip_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """GitHub archive .zip URLs should download, not be treated as git clone."""
    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    _patch_httpx_stream(monkeypatch, _build_plugin_zip("repo-main"))

    with patch("subprocess.run") as mock_run:
        source, _ = _resolve_source("https://github.com/org/repo/archive/refs/heads/main.zip")
    mock_run.assert_not_called()
    assert (source / "plugin.json").exists()


def test_resolve_source_zip_url_download_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """HTTP error during download should exit cleanly and clean up tmp."""
    import httpx

    monkeypatch.setattr("tempfile.mkdtemp", lambda **kw: str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()

    class _FailingStream:
        def __enter__(self):
            raise httpx.ConnectError("boom")

        def __exit__(self, *exc_info):
            return False

    monkeypatch.setattr(httpx, "stream", lambda *a, **kw: _FailingStream())

    with pytest.raises(typer.Exit):
        _resolve_source("https://example.com/missing.zip")
    assert not (tmp_path / "tmp").exists()

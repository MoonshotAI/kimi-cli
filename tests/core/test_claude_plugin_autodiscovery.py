"""Tests for Claude plugin auto-discovery from ~/.kimi/claude-plugins/."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def _make_plugin_in(parent: Path, name: str) -> Path:
    """Create a valid Claude plugin directory under *parent*."""
    plugin_dir = parent / name
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": name, "version": "1.0.0", "description": f"{name} plugin"}),
        encoding="utf-8",
    )
    return plugin_dir


class TestGetClaudePluginsDir:
    def test_returns_claude_plugins_subdir(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
        from kimi_cli.claude_plugin.discovery import get_claude_plugins_dir

        result = get_claude_plugins_dir()
        assert result == tmp_path / "claude-plugins"

    def test_does_not_create_directory(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
        from kimi_cli.claude_plugin.discovery import get_claude_plugins_dir

        result = get_claude_plugins_dir()
        # get_share_dir() creates ~/.kimi/ but claude-plugins/ must NOT be auto-created
        assert not result.exists()


class TestDiscoverDefaultDirs:
    def test_empty_when_dir_does_not_exist(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
        from kimi_cli.claude_plugin.discovery import discover_default_claude_plugin_dirs

        result = discover_default_claude_plugin_dirs()
        assert result == []

    def test_discovers_valid_plugin_subdirs(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
        base = tmp_path / "claude-plugins"
        base.mkdir()
        _make_plugin_in(base, "alpha")
        _make_plugin_in(base, "beta")

        from kimi_cli.claude_plugin.discovery import discover_default_claude_plugin_dirs

        result = discover_default_claude_plugin_dirs()
        names = [d.name for d in result]
        assert sorted(names) == ["alpha", "beta"]

    def test_skips_dirs_without_manifest(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
        base = tmp_path / "claude-plugins"
        base.mkdir()
        _make_plugin_in(base, "valid")
        # Create a dir without .claude-plugin/plugin.json
        (base / "invalid-dir").mkdir()
        # Create a plain file (not a dir)
        (base / "readme.txt").write_text("ignore me", encoding="utf-8")

        from kimi_cli.claude_plugin.discovery import discover_default_claude_plugin_dirs

        result = discover_default_claude_plugin_dirs()
        assert len(result) == 1
        assert result[0].name == "valid"

    def test_returns_resolved_paths(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
        base = tmp_path / "claude-plugins"
        base.mkdir()
        _make_plugin_in(base, "demo")

        from kimi_cli.claude_plugin.discovery import discover_default_claude_plugin_dirs

        result = discover_default_claude_plugin_dirs()
        for p in result:
            assert p == p.resolve()


class TestAutoDiscoveryFailOpen:
    def test_unreadable_dir_returns_empty(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """When ~/.kimi/claude-plugins/ exists but iterdir() raises OSError,
        auto-discovery must return [] instead of crashing."""
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
        base = tmp_path / "claude-plugins"
        base.mkdir()

        from kimi_cli.claude_plugin.discovery import discover_default_claude_plugin_dirs

        # Patch iterdir on this specific path to raise OSError
        _original_iterdir = base.iterdir

        def _raise_oserror(*_a: object, **_kw: object) -> None:
            raise OSError("Permission denied")

        monkeypatch.setattr(type(base), "iterdir", lambda self: _raise_oserror())

        result = discover_default_claude_plugin_dirs()
        assert result == []


class TestMergeWithExplicit:
    def test_both_sources_loaded(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """Explicit --plugin-dir and auto-discovered dirs should both load."""
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

        # Auto-discovered
        base = tmp_path / "claude-plugins"
        base.mkdir()
        _make_plugin_in(base, "auto-plugin")

        # Explicit
        explicit_dir = _make_plugin_in(tmp_path / "explicit", "explicit-plugin")

        from kimi_cli.claude_plugin.discovery import (
            discover_default_claude_plugin_dirs,
            load_claude_plugins,
        )

        auto_dirs = discover_default_claude_plugin_dirs()
        all_dirs = [explicit_dir, *auto_dirs]
        bundle = load_claude_plugins(all_dirs)

        assert "explicit-plugin" in bundle.plugins
        assert "auto-plugin" in bundle.plugins

    def test_duplicate_paths_are_deduplicated(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
        base = tmp_path / "claude-plugins"
        base.mkdir()
        plugin_dir = _make_plugin_in(base, "shared")

        from kimi_cli.claude_plugin.discovery import (
            discover_default_claude_plugin_dirs,
            load_claude_plugins,
        )

        auto_dirs = discover_default_claude_plugin_dirs()
        # Simulate passing the same dir explicitly
        explicit_dirs = [plugin_dir.resolve()]

        # Deduplicate by resolved path (same logic as cli/__init__.py)
        seen: set[Path] = set()
        merged: list[Path] = []
        for d in [*explicit_dirs, *auto_dirs]:
            rd = d.resolve()
            if rd not in seen:
                seen.add(rd)
                merged.append(rd)

        assert len(merged) == 1
        bundle = load_claude_plugins(merged)
        assert len(bundle.plugins) == 1

    def test_explicit_wins_on_name_conflict(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """When explicit and auto dirs have plugins with the same name,
        explicit should win because it comes first in the merged list."""
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

        # Auto-discovered plugin named "conflict"
        base = tmp_path / "claude-plugins"
        base.mkdir()
        _make_plugin_in(base, "conflict")

        # Explicit plugin also named "conflict" but at a different path
        explicit_dir = _make_plugin_in(tmp_path / "explicit", "conflict")

        from kimi_cli.claude_plugin.discovery import (
            discover_default_claude_plugin_dirs,
            load_claude_plugins,
        )

        auto_dirs = discover_default_claude_plugin_dirs()
        # Explicit first, then auto (matching cli/__init__.py merge order)
        all_dirs = [explicit_dir, *auto_dirs]
        bundle = load_claude_plugins(all_dirs)

        # Only one plugin with name "conflict", and it should be the explicit one
        assert len(bundle.plugins) == 1
        assert bundle.plugins["conflict"].root == explicit_dir.resolve()


class TestCLIHelpUnchanged:
    def test_help_still_shows_plugin_dir(self) -> None:
        from typer.testing import CliRunner

        from kimi_cli.cli import cli

        runner = CliRunner()
        result = runner.invoke(cli, ["--help"])
        assert "--plugin-dir" in result.output

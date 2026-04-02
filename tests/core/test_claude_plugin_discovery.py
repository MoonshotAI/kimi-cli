"""Tests for Claude plugin discovery and manifest parsing."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def _make_plugin(tmp_path: Path, name: str = "demo", *, version: str = "1.0.0") -> Path:
    """Create a minimal Claude plugin directory."""
    plugin_dir = tmp_path / name
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": name, "version": version, "description": f"{name} plugin"}),
        encoding="utf-8",
    )
    return plugin_dir


class TestManifestDiscovery:
    def test_discover_valid_plugin(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert list(bundle.plugins) == ["demo"]
        assert bundle.plugins["demo"].manifest.name == "demo"
        assert bundle.plugins["demo"].manifest.version == "1.0.0"
        assert bundle.plugins["demo"].root == plugin_dir

    def test_missing_manifest_is_skipped(self, tmp_path: Path) -> None:
        plugin_dir = tmp_path / "bad"
        plugin_dir.mkdir()

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert len(bundle.plugins) == 0

    def test_duplicate_name_is_rejected(self, tmp_path: Path) -> None:
        dir1 = _make_plugin(tmp_path / "a", "dup")
        dir2 = _make_plugin(tmp_path / "b", "dup")

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([dir1, dir2])
        # First one wins
        assert len(bundle.plugins) == 1
        assert bundle.plugins["dup"].root == dir1

    def test_multiple_plugins(self, tmp_path: Path) -> None:
        dir1 = _make_plugin(tmp_path, "alpha")
        dir2 = _make_plugin(tmp_path, "beta")

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([dir1, dir2])
        assert sorted(bundle.plugins.keys()) == ["alpha", "beta"]

    def test_empty_plugin_dirs(self) -> None:
        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([])
        assert len(bundle.plugins) == 0


class TestPluginSkillDiscovery:
    def test_plugin_skills_are_namespaced(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")
        skill_dir = plugin_dir / "skills" / "hello"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: hello\ndescription: say hello\n---\nHello world",
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert "demo:hello" in bundle.plugins["demo"].skills
        skill = bundle.plugins["demo"].skills["demo:hello"]
        assert skill.name == "demo:hello"
        assert skill.description == "say hello"

    def test_invalid_skill_is_skipped(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")
        skill_dir = plugin_dir / "skills" / "broken"
        skill_dir.mkdir(parents=True)
        # SKILL.md with invalid content (no frontmatter, file exists but empty dir)
        (skill_dir / "SKILL.md").write_text("", encoding="utf-8")

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        # Skill should still be loaded with defaults (name from dir, default description)
        assert "demo:broken" in bundle.plugins["demo"].skills

    def test_no_skills_dir(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert len(bundle.plugins["demo"].skills) == 0

    def test_unreadable_skills_dir_skips_skills_not_plugin(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")
        skills_dir = plugin_dir / "skills"
        skills_dir.mkdir()
        (skills_dir / "hello").mkdir()
        (skills_dir / "hello" / "SKILL.md").write_text(
            "---\nname: hello\ndescription: say hello\n---\nHello world",
            encoding="utf-8",
        )
        commands_dir = plugin_dir / "commands"
        commands_dir.mkdir()
        (commands_dir / "ping.md").write_text(
            "---\ndescription: ping command\n---\nPing.",
            encoding="utf-8",
        )

        original_iterdir = Path.iterdir

        def _fake_iterdir(self: Path):
            if self == skills_dir:
                raise OSError("Permission denied")
            return original_iterdir(self)

        monkeypatch.setattr(Path, "iterdir", _fake_iterdir)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert "demo" in bundle.plugins
        assert len(bundle.plugins["demo"].skills) == 0
        assert "demo:ping" in bundle.plugins["demo"].commands
        assert any("skills" in w.lower() or "permission denied" in w.lower() for w in bundle.plugins["demo"].warnings)


class TestPluginSettings:
    def test_settings_selects_default_agent(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")
        agents_dir = plugin_dir / "agents"
        agents_dir.mkdir()
        (agents_dir / "reviewer.md").write_text(
            "---\nname: reviewer\ndescription: code reviewer\n---\nReview code.",
            encoding="utf-8",
        )
        (plugin_dir / "settings.json").write_text(
            json.dumps({"agent": "reviewer"}),
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert bundle.plugins["demo"].default_agent_file == agents_dir / "reviewer.md"

    def test_settings_missing_agent_warns(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")
        (plugin_dir / "settings.json").write_text(
            json.dumps({"agent": "nonexistent"}),
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert bundle.plugins["demo"].default_agent_file is None
        assert any("nonexistent" in w for w in bundle.plugins["demo"].warnings)

    def test_settings_rejects_agent_path_outside_plugin_agents_dir(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")
        (plugin_dir / "agents").mkdir()
        outside_agent = tmp_path / "outside.md"
        outside_agent.write_text(
            "---\nname: outside\ndescription: outside agent\n---\nOutside.",
            encoding="utf-8",
        )
        (plugin_dir / "settings.json").write_text(
            json.dumps({"agent": "../../outside"}),
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert bundle.plugins["demo"].default_agent_file is None
        assert any(
            "outside plugin agents" in w.lower() or "outside plugin" in w.lower()
            for w in bundle.plugins["demo"].warnings
        )

    def test_unsupported_settings_keys_warn(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")
        (plugin_dir / "settings.json").write_text(
            json.dumps({"agent": "foo", "theme": "dark", "unknown": True}),
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert any("Unsupported settings.json" in w for w in bundle.plugins["demo"].warnings)

    def test_settings_json_non_object_root_skips_settings_not_plugin(self, tmp_path: Path) -> None:
        """settings.json with a non-object root (e.g. []) must not crash
        the entire plugin load."""
        plugin_dir = _make_plugin(tmp_path, "demo")
        (plugin_dir / "settings.json").write_text("[]", encoding="utf-8")

        # Add a skill to verify it survives
        skill_dir = plugin_dir / "skills" / "hello"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: hello\ndescription: a skill\n---\nHello",
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])

        assert "demo" in bundle.plugins
        assert bundle.plugins["demo"].default_agent_file is None
        assert any("settings" in w.lower() or "not" in w.lower() or "dict" in w.lower()
                    for w in bundle.plugins["demo"].warnings)
        assert "demo:hello" in bundle.plugins["demo"].skills


class TestCLIOption:
    def test_cli_help_shows_plugin_dir(self) -> None:
        from typer.testing import CliRunner

        from kimi_cli.cli import cli

        runner = CliRunner()
        result = runner.invoke(cli, ["--help"])
        assert "--plugin-dir" in result.output

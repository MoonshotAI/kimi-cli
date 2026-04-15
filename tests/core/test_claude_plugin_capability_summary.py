"""Tests for plugin capability summary generation."""

from __future__ import annotations

import json
from pathlib import Path


def _make_plugin(tmp_path: Path, name: str = "demo") -> Path:
    plugin_dir = tmp_path / name
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": name, "version": "1.0.0", "description": f"{name} plugin"}),
        encoding="utf-8",
    )
    return plugin_dir


class TestCapabilitySummary:
    def test_summary_includes_skills_with_path(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")
        skill_dir = plugin_dir / "skills" / "hello"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: hello\ndescription: say hello\n---\nHello",
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import (
            build_plugin_capability_summary,
            load_claude_plugins,
        )

        bundle = load_claude_plugins([plugin_dir])
        summary = build_plugin_capability_summary(bundle)

        assert "demo:hello" in summary
        assert "say hello" in summary
        assert "SKILL.md" in summary  # model should know to read it

    def test_summary_includes_commands_as_slash_only(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")
        cmd_dir = plugin_dir / "commands"
        cmd_dir.mkdir()
        (cmd_dir / "review.md").write_text(
            "---\ndescription: review code\n---\nReview $ARGUMENTS",
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import (
            build_plugin_capability_summary,
            load_claude_plugins,
        )

        bundle = load_claude_plugins([plugin_dir])
        summary = build_plugin_capability_summary(bundle)

        assert "demo:review" in summary
        assert "review code" in summary
        assert "slash command" in summary.lower()

    def test_summary_omits_commands_that_conflict_with_registered_skill_names(
        self, tmp_path: Path,
    ) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")
        skill_dir = plugin_dir / "skills" / "hello"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: hello\ndescription: say hello\n---\nHello",
            encoding="utf-8",
        )
        cmd_dir = plugin_dir / "commands"
        cmd_dir.mkdir()
        (cmd_dir / "hello.md").write_text(
            "---\ndescription: conflicting command\n---\nRun hello",
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import (
            build_plugin_capability_summary,
            load_claude_plugins,
        )

        bundle = load_claude_plugins([plugin_dir])
        summary = build_plugin_capability_summary(bundle)

        assert "say hello" in summary
        assert "conflicting command" not in summary
        assert "/demo:hello" not in summary

    def test_summary_respects_reserved_command_names(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "skill")
        cmd_dir = plugin_dir / "commands"
        cmd_dir.mkdir()
        (cmd_dir / "hello.md").write_text(
            "---\ndescription: reserved command\n---\nRun hello",
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import (
            build_plugin_capability_summary,
            load_claude_plugins,
        )

        bundle = load_claude_plugins([plugin_dir])
        summary = build_plugin_capability_summary(
            bundle,
            reserved_command_names={"skill:hello"},
        )

        assert "reserved command" not in summary
        assert "/skill:hello" not in summary

    def test_summary_omits_skills_not_in_registered_plugin_skill_set(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "skill")
        skill_dir = plugin_dir / "skills" / "hello"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: hello\ndescription: conflicting skill\n---\nHello",
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import (
            build_plugin_capability_summary,
            load_claude_plugins,
        )

        bundle = load_claude_plugins([plugin_dir])
        summary = build_plugin_capability_summary(
            bundle,
            registered_plugin_skill_names=set(),
        )

        assert "conflicting skill" not in summary
        assert "skill:hello" not in summary

    def test_summary_omits_agents(self, tmp_path: Path) -> None:
        """Agents are not autonomously executable — must not appear."""
        plugin_dir = _make_plugin(tmp_path, "demo")
        agents_dir = plugin_dir / "agents"
        agents_dir.mkdir()
        (agents_dir / "checker.md").write_text(
            "---\nname: checker\ndescription: code checker\n---\nCheck code.",
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import (
            build_plugin_capability_summary,
            load_claude_plugins,
        )

        bundle = load_claude_plugins([plugin_dir])
        summary = build_plugin_capability_summary(bundle)

        # Agents should not appear in the summary
        assert "checker" not in summary
        assert "(agent)" not in summary

    def test_summary_has_plugin_header(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin(tmp_path, "demo")
        skill_dir = plugin_dir / "skills" / "hello"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: hello\ndescription: test\n---\nHello",
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import (
            build_plugin_capability_summary,
            load_claude_plugins,
        )

        bundle = load_claude_plugins([plugin_dir])
        summary = build_plugin_capability_summary(bundle)

        assert "Plugin: demo" in summary
        assert "v1.0.0" in summary
        assert "Loaded Claude-compatible plugins" in summary

    def test_empty_bundle_returns_empty_string(self) -> None:
        from kimi_cli.claude_plugin.discovery import build_plugin_capability_summary
        from kimi_cli.claude_plugin.spec import ClaudePluginBundle

        bundle = ClaudePluginBundle(plugins={})
        assert build_plugin_capability_summary(bundle) == ""

    def test_agent_only_plugin_produces_empty_summary(self, tmp_path: Path) -> None:
        """A plugin with only agents and no skills/commands → empty summary."""
        plugin_dir = _make_plugin(tmp_path, "demo")
        agents_dir = plugin_dir / "agents"
        agents_dir.mkdir()
        (agents_dir / "checker.md").write_text(
            "---\nname: checker\ndescription: code checker\n---\nCheck.",
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import (
            build_plugin_capability_summary,
            load_claude_plugins,
        )

        bundle = load_claude_plugins([plugin_dir])
        assert build_plugin_capability_summary(bundle) == ""

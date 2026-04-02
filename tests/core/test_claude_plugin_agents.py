"""Tests for Claude plugin agent parsing and settings.json agent selection."""

from __future__ import annotations

import json
from pathlib import Path


def _make_plugin_with_agent(
    tmp_path: Path,
    plugin_name: str = "demo",
    agent_name: str = "reviewer",
    *,
    body: str = "You are a code reviewer. Review carefully.",
    frontmatter: dict | None = None,
) -> Path:
    plugin_dir = tmp_path / plugin_name
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": plugin_name, "version": "1.0.0"}),
        encoding="utf-8",
    )

    agents_dir = plugin_dir / "agents"
    agents_dir.mkdir()

    fm = frontmatter or {"name": agent_name, "description": f"{agent_name} agent"}
    fm_text = "\n".join(f"{k}: {v}" for k, v in fm.items())
    (agents_dir / f"{agent_name}.md").write_text(
        f"---\n{fm_text}\n---\n{body}",
        encoding="utf-8",
    )
    return plugin_dir


class TestAgentParsing:
    def test_parse_agent_md(self, tmp_path: Path) -> None:
        from kimi_cli.claude_plugin.agents import parse_agent_md

        agent_file = tmp_path / "reviewer.md"
        agent_file.write_text(
            "---\nname: reviewer\ndescription: code reviewer\n---\nReview code carefully.",
            encoding="utf-8",
        )

        spec = parse_agent_md(agent_file, "acme")
        assert spec.name == "reviewer"
        assert spec.full_name == "acme:reviewer"
        assert spec.description == "code reviewer"
        assert "Review code carefully." in spec.system_prompt
        assert spec.file_path == agent_file

    def test_parse_agent_without_frontmatter_name(self, tmp_path: Path) -> None:
        from kimi_cli.claude_plugin.agents import parse_agent_md

        agent_file = tmp_path / "checker.md"
        agent_file.write_text(
            "---\ndescription: checker agent\n---\nCheck things.",
            encoding="utf-8",
        )

        spec = parse_agent_md(agent_file, "acme")
        # name defaults to file stem
        assert spec.name == "checker"
        assert spec.full_name == "acme:checker"


class TestAgentDiscovery:
    def test_agents_are_discovered(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin_with_agent(tmp_path)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert "demo:reviewer" in bundle.plugins["demo"].agents
        agent = bundle.plugins["demo"].agents["demo:reviewer"]
        assert "code reviewer" in agent.system_prompt.lower() or agent.description == "reviewer agent"

    def test_no_agents_dir(self, tmp_path: Path) -> None:
        plugin_dir = tmp_path / "demo"
        (plugin_dir / ".claude-plugin").mkdir(parents=True)
        (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "demo", "version": "1.0.0"}),
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert len(bundle.plugins["demo"].agents) == 0


class TestPluginAgentOverlay:
    def test_plugin_agent_md_is_detected_as_plugin_relative(self, tmp_path: Path) -> None:
        """When settings.json selects a .md agent, app.py must detect
        it belongs to a plugin and overlay its system prompt instead of
        passing it to the YAML-only loader."""
        plugin_dir = _make_plugin_with_agent(tmp_path, body="Custom plugin prompt.")
        agent_file = plugin_dir / "agents" / "reviewer.md"

        from kimi_cli.claude_plugin.agents import parse_agent_md
        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        # Simulate what app.py does: detect the file is relative to a plugin
        found_spec = None
        for pname, prt in bundle.plugins.items():
            if agent_file.is_relative_to(prt.root):
                found_spec = parse_agent_md(agent_file, pname)
                break

        assert found_spec is not None
        assert found_spec.full_name == "demo:reviewer"
        assert "Custom plugin prompt." in found_spec.system_prompt


class TestSettingsAgentSelection:
    def test_settings_selects_agent(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin_with_agent(tmp_path)
        (plugin_dir / "settings.json").write_text(
            json.dumps({"agent": "reviewer"}),
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert bundle.plugins["demo"].default_agent_file is not None
        assert bundle.plugins["demo"].default_agent_file.name == "reviewer.md"

    def test_settings_without_agent_key(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin_with_agent(tmp_path)
        (plugin_dir / "settings.json").write_text(
            json.dumps({"theme": "dark"}),
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert bundle.plugins["demo"].default_agent_file is None

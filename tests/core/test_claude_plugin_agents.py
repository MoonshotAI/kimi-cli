"""Tests for Claude plugin agent parsing and settings.json agent selection."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


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

    def test_unreadable_agents_dir_skips_agents_not_plugin(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        plugin_dir = _make_plugin_with_agent(tmp_path)
        agents_dir = plugin_dir / "agents"
        skill_dir = plugin_dir / "skills" / "hello"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: hello\ndescription: say hello\n---\nHello world",
            encoding="utf-8",
        )

        original_iterdir = Path.iterdir

        def _fake_iterdir(self: Path):
            if self == agents_dir:
                raise OSError("Permission denied")
            return original_iterdir(self)

        monkeypatch.setattr(Path, "iterdir", _fake_iterdir)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert "demo" in bundle.plugins
        assert len(bundle.plugins["demo"].agents) == 0
        assert "demo:hello" in bundle.plugins["demo"].skills
        assert any("agent" in w.lower() or "permission denied" in w.lower() for w in bundle.plugins["demo"].warnings)


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


class TestNonPluginMdAgentPreserved:
    def test_non_plugin_md_agent_not_replaced(self, tmp_path: Path) -> None:
        """A user-provided .md agent file that is NOT inside any plugin root
        must NOT be replaced with DEFAULT_AGENT_FILE."""
        from kimi_cli.agentspec import DEFAULT_AGENT_FILE
        from kimi_cli.claude_plugin.agents import parse_agent_md
        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        # Create a plugin
        plugin_dir = _make_plugin_with_agent(tmp_path)
        bundle = load_claude_plugins([plugin_dir])

        # Create a non-plugin .md agent file outside any plugin root
        non_plugin_md = tmp_path / "my-custom-agent.md"
        non_plugin_md.write_text(
            "---\nname: custom\ndescription: custom agent\n---\nCustom prompt.",
            encoding="utf-8",
        )

        # Simulate app.py logic: detect if agent_file belongs to a plugin
        agent_file = non_plugin_md
        _claude_plugin_agent_spec = None
        for _pname, _prt in bundle.plugins.items():
            if agent_file.is_relative_to(_prt.root):
                _claude_plugin_agent_spec = parse_agent_md(agent_file, _pname)
                break

        # Only replace if matched
        if _claude_plugin_agent_spec is not None:
            agent_file = DEFAULT_AGENT_FILE

        # agent_file must NOT have been replaced
        assert agent_file == non_plugin_md
        assert _claude_plugin_agent_spec is None

    def test_plugin_md_agent_does_get_replaced(self, tmp_path: Path) -> None:
        """A .md file inside a plugin root should trigger the fallback."""
        from kimi_cli.agentspec import DEFAULT_AGENT_FILE
        from kimi_cli.claude_plugin.agents import parse_agent_md
        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        plugin_dir = _make_plugin_with_agent(tmp_path)
        bundle = load_claude_plugins([plugin_dir])

        agent_file = plugin_dir / "agents" / "reviewer.md"
        _claude_plugin_agent_spec = None
        for _pname, _prt in bundle.plugins.items():
            if agent_file.is_relative_to(_prt.root):
                _claude_plugin_agent_spec = parse_agent_md(agent_file, _pname)
                break

        if _claude_plugin_agent_spec is not None:
            agent_file = DEFAULT_AGENT_FILE

        assert agent_file == DEFAULT_AGENT_FILE

    def test_relative_path_plugin_agent_is_recognized(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """A relative-path agent_file that resolves inside a plugin root
        must be recognized as a plugin agent."""
        from kimi_cli.agentspec import DEFAULT_AGENT_FILE
        from kimi_cli.claude_plugin.agents import parse_agent_md
        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        plugin_dir = _make_plugin_with_agent(tmp_path)
        bundle = load_claude_plugins([plugin_dir])

        # Simulate: user is cd'd into the plugin dir and passes a relative path
        monkeypatch.chdir(plugin_dir)
        agent_file = Path("agents/reviewer.md")  # relative

        # Replicate app.py logic WITH resolve
        resolved = agent_file.resolve()
        _claude_plugin_agent_spec = None
        for _pname, _prt in bundle.plugins.items():
            if resolved.is_relative_to(_prt.root):
                _claude_plugin_agent_spec = parse_agent_md(resolved, _pname)
                break

        if _claude_plugin_agent_spec is not None:
            agent_file = DEFAULT_AGENT_FILE

        assert agent_file == DEFAULT_AGENT_FILE
        assert _claude_plugin_agent_spec is not None
        assert _claude_plugin_agent_spec.full_name == "demo:reviewer"

    def test_relative_path_non_plugin_agent_not_misidentified(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """A relative-path .md that is NOT inside any plugin root must not
        be recognized as a plugin agent, even when plugins are loaded."""
        from kimi_cli.agentspec import DEFAULT_AGENT_FILE
        from kimi_cli.claude_plugin.agents import parse_agent_md
        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        plugin_dir = _make_plugin_with_agent(tmp_path)
        bundle = load_claude_plugins([plugin_dir])

        # Create a non-plugin .md outside the plugin root
        other_dir = tmp_path / "other"
        other_dir.mkdir()
        custom_md = other_dir / "custom.md"
        custom_md.write_text("---\nname: custom\n---\nCustom.", encoding="utf-8")

        monkeypatch.chdir(other_dir)
        agent_file = Path("custom.md")  # relative

        resolved = agent_file.resolve()
        _claude_plugin_agent_spec = None
        for _pname, _prt in bundle.plugins.items():
            if resolved.is_relative_to(_prt.root):
                _claude_plugin_agent_spec = parse_agent_md(resolved, _pname)
                break

        if _claude_plugin_agent_spec is not None:
            agent_file = DEFAULT_AGENT_FILE

        assert agent_file == Path("custom.md")
        assert _claude_plugin_agent_spec is None


class TestBrokenPluginAgentBestEffort:
    def test_invalid_agent_markdown_does_not_crash(self, tmp_path: Path) -> None:
        """When a plugin agent .md exists but has broken frontmatter,
        the plugin-agent detection in app.py must not crash — it should
        skip the overlay and keep the original agent_file."""
        from kimi_cli.agentspec import DEFAULT_AGENT_FILE
        from kimi_cli.claude_plugin.agents import parse_agent_md
        from kimi_cli.claude_plugin.discovery import load_claude_plugins
        from kimi_cli.utils.logging import logger

        plugin_dir = tmp_path / "demo"
        (plugin_dir / ".claude-plugin").mkdir(parents=True)
        (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "demo", "version": "1.0.0"}),
            encoding="utf-8",
        )
        agents_dir = plugin_dir / "agents"
        agents_dir.mkdir()
        # Valid YAML open but bad structure that makes parse_agent_md raise
        (agents_dir / "reviewer.md").write_text(
            "---\n: invalid yaml frontmatter\n---\nBody.",
            encoding="utf-8",
        )

        bundle = load_claude_plugins([plugin_dir])
        agent_file = plugin_dir / "agents" / "reviewer.md"

        # Replicate app.py logic: try to parse, catch failure
        _resolved = agent_file.resolve()
        _claude_plugin_agent_spec = None
        for _pname, _prt in bundle.plugins.items():
            if _resolved.is_relative_to(_prt.root):
                try:
                    _claude_plugin_agent_spec = parse_agent_md(_resolved, _pname)
                except Exception:
                    logger.warning("Bad plugin agent, skipping")
                break

        if _claude_plugin_agent_spec is not None:
            agent_file = DEFAULT_AGENT_FILE

        # Must NOT have switched to DEFAULT_AGENT_FILE
        assert agent_file != DEFAULT_AGENT_FILE
        assert _claude_plugin_agent_spec is None

    @pytest.mark.asyncio
    async def test_invalid_default_plugin_agent_falls_back_to_default_agent(
        self,
        session,
        config,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A broken settings-selected plugin agent must not leave KimiCLI.create()
        pointing at the invalid markdown file.

        The plugin default-agent override should fail open and fall back to the
        default YAML agent instead of crashing startup.
        """
        import kimi_cli.app as app_module
        from kimi_cli.agentspec import DEFAULT_AGENT_FILE
        from kimi_cli.app import KimiCLI

        plugin_dir = tmp_path / "demo"
        (plugin_dir / ".claude-plugin").mkdir(parents=True)
        (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "demo", "version": "1.0.0"}),
            encoding="utf-8",
        )
        agents_dir = plugin_dir / "agents"
        agents_dir.mkdir()
        (agents_dir / "reviewer.md").write_text(
            "---\n: invalid yaml frontmatter\n---\nBody.",
            encoding="utf-8",
        )
        (plugin_dir / "settings.json").write_text(
            json.dumps({"agent": "reviewer"}),
            encoding="utf-8",
        )

        fake_runtime = SimpleNamespace(
            session=session,
            config=config,
            llm=None,
            notifications=SimpleNamespace(recover=lambda: None),
            background_tasks=SimpleNamespace(reconcile=lambda: None),
            skills={},
            skills_dirs=[],
            builtin_args=SimpleNamespace(KIMI_SKILLS="No skills found."),
        )
        fake_agent = SimpleNamespace(name="Test Agent", system_prompt="Test system prompt")
        fake_context = SimpleNamespace(system_prompt=None)
        fake_context.restore = AsyncMock()
        fake_context.write_system_prompt = AsyncMock()
        captured: dict[str, Path] = {}

        async def fake_runtime_create(*_args, **_kwargs):
            return fake_runtime

        async def fake_load_agent(agent_file, *_args, **_kwargs):
            captured["agent_file"] = agent_file
            return fake_agent

        class _FakeSoul:
            def __init__(self, agent, context):
                self.plan_mode = False

            def register_plugin_commands(self, _bundle) -> None:
                pass

            def set_hook_engine(self, engine) -> None:
                pass

        monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
        monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda provider, model: {})
        monkeypatch.setattr(app_module, "create_llm", lambda *args, **kwargs: None)
        monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
        monkeypatch.setattr(app_module, "load_agent", fake_load_agent)
        monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)
        monkeypatch.setattr(app_module, "KimiSoul", _FakeSoul)

        await KimiCLI.create(session, config=config, plugin_dirs=[plugin_dir])

        assert captured["agent_file"] == DEFAULT_AGENT_FILE


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

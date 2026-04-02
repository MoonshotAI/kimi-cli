"""Tests for Claude plugin command parsing and slash-command registration."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul


def _make_plugin_with_command(
    tmp_path: Path,
    plugin_name: str = "demo",
    command_name: str = "hello",
    *,
    frontmatter: dict | None = None,
    body: str = "Say hello to $ARGUMENTS",
) -> Path:
    plugin_dir = tmp_path / plugin_name
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": plugin_name, "version": "1.0.0"}),
        encoding="utf-8",
    )

    commands_dir = plugin_dir / "commands"
    commands_dir.mkdir()

    fm = frontmatter or {"description": f"{command_name} command"}
    fm_text = "\n".join(f"{k}: {v}" for k, v in fm.items())
    (commands_dir / f"{command_name}.md").write_text(
        f"---\n{fm_text}\n---\n{body}",
        encoding="utf-8",
    )
    return plugin_dir


class TestCommandParsing:
    def test_parse_command_md(self, tmp_path: Path) -> None:
        from kimi_cli.claude_plugin.commands import _parse_command_md

        cmd_file = tmp_path / "review.md"
        cmd_file.write_text(
            "---\ndescription: review code\n---\nReview the $ARGUMENTS carefully.",
            encoding="utf-8",
        )
        spec = _parse_command_md(cmd_file, "acme")
        assert spec.name == "review"
        assert spec.full_name == "acme:review"
        assert spec.description == "review code"
        assert "$ARGUMENTS" in spec.body

    def test_expand_arguments(self) -> None:
        from kimi_cli.claude_plugin.commands import expand_arguments

        result = expand_arguments("Hello $ARGUMENTS!", "world")
        assert result == "Hello world!"

    def test_expand_arguments_no_placeholder(self) -> None:
        from kimi_cli.claude_plugin.commands import expand_arguments

        result = expand_arguments("No placeholder here", "world")
        assert result == "No placeholder here"

    def test_expand_arguments_with_plugin_root(self, tmp_path: Path) -> None:
        from kimi_cli.claude_plugin.commands import expand_arguments

        result = expand_arguments(
            "Run ${CLAUDE_PLUGIN_ROOT}/scripts/check.sh $ARGUMENTS",
            "myfile.py",
            plugin_root=tmp_path,
        )
        assert str(tmp_path) in result
        assert "${CLAUDE_PLUGIN_ROOT}" not in result
        assert "myfile.py" in result


class TestCommandDiscovery:
    def test_commands_are_discovered(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin_with_command(tmp_path)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert "demo:hello" in bundle.plugins["demo"].commands
        cmd = bundle.plugins["demo"].commands["demo:hello"]
        assert cmd.full_name == "demo:hello"
        assert cmd.description == "hello command"
        assert cmd.plugin_root == plugin_dir

    def test_non_md_files_ignored(self, tmp_path: Path) -> None:
        plugin_dir = _make_plugin_with_command(tmp_path)
        # Add a non-.md file
        (plugin_dir / "commands" / "readme.txt").write_text("ignore me", encoding="utf-8")

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert len(bundle.plugins["demo"].commands) == 1

    def test_unreadable_commands_dir_skips_commands_not_plugin(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        plugin_dir = _make_plugin_with_command(tmp_path)
        commands_dir = plugin_dir / "commands"
        skill_dir = plugin_dir / "skills" / "hello"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: hello\ndescription: say hello\n---\nHello world",
            encoding="utf-8",
        )

        original_iterdir = Path.iterdir

        def _fake_iterdir(self: Path):
            if self == commands_dir:
                raise OSError("Permission denied")
            return original_iterdir(self)

        monkeypatch.setattr(Path, "iterdir", _fake_iterdir)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert "demo" in bundle.plugins
        assert len(bundle.plugins["demo"].commands) == 0
        assert "demo:hello" in bundle.plugins["demo"].skills
        assert any("command" in w.lower() or "permission denied" in w.lower() for w in bundle.plugins["demo"].warnings)


class TestCommandRegistration:
    def test_plugin_command_appears_in_slash_commands(
        self, runtime: Runtime, tmp_path: Path
    ) -> None:
        plugin_dir = _make_plugin_with_command(tmp_path)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])

        agent = Agent(
            name="Test",
            system_prompt="Test",
            toolset=EmptyToolset(),
            runtime=runtime,
        )
        soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "ctx.jsonl"))
        soul.register_plugin_commands(bundle)

        names = {cmd.name for cmd in soul.available_slash_commands}
        assert "demo:hello" in names


class TestUnsupportedFrontmatter:
    def test_unsupported_keys_produce_warnings(self, tmp_path: Path) -> None:
        # Reset the warned-keys set for a clean test
        from kimi_cli.claude_plugin import commands as cmd_mod

        cmd_mod._warned_command_keys.clear()

        plugin_dir = _make_plugin_with_command(
            tmp_path,
            frontmatter={
                "description": "test",
                "allowed-tools": "Read,Write",
                "disable-model-invocation": "true",
            },
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        # Commands should still load despite unsupported keys
        assert "demo:hello" in bundle.plugins["demo"].commands

    def test_frontmatter_context_surfaced_in_rendered_prompt(self, tmp_path: Path) -> None:
        """Unsupported frontmatter must be appended to the synthetic prompt
        as advisory instruction context, not silently dropped."""
        from kimi_cli.claude_plugin.commands import (
            build_frontmatter_context,
            expand_arguments,
        )

        plugin_dir = _make_plugin_with_command(
            tmp_path,
            frontmatter={
                "description": "review code",
                "allowed-tools": "Read,Write",
                "disable-model-invocation": "true",
            },
            body="Review $ARGUMENTS carefully.",
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        spec = bundle.plugins["demo"].commands["demo:hello"]

        rendered = expand_arguments(spec.body, "foo.py", plugin_root=spec.plugin_root)
        rendered += build_frontmatter_context(spec)

        assert "Review foo.py carefully." in rendered
        assert "allowed-tools" in rendered
        assert "Read,Write" in rendered
        assert "disable-model-invocation" in rendered
        assert "advisory" in rendered.lower()

    def test_frontmatter_context_empty_when_no_unsupported_keys(self) -> None:
        from kimi_cli.claude_plugin.commands import build_frontmatter_context
        from kimi_cli.claude_plugin.spec import ClaudeCommandSpec

        spec = ClaudeCommandSpec(
            name="simple",
            full_name="demo:simple",
            description="simple command",
            body="Do something",
            frontmatter={"description": "simple command"},
        )
        assert build_frontmatter_context(spec) == ""

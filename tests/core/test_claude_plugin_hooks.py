"""Tests for Claude plugin hook translation."""

from __future__ import annotations

import json
from pathlib import Path


def _make_plugin_with_hooks(
    tmp_path: Path,
    hooks_data: dict,
    plugin_name: str = "demo",
) -> Path:
    plugin_dir = tmp_path / plugin_name
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": plugin_name, "version": "1.0.0"}),
        encoding="utf-8",
    )

    hooks_dir = plugin_dir / "hooks"
    hooks_dir.mkdir()
    (hooks_dir / "hooks.json").write_text(
        json.dumps(hooks_data),
        encoding="utf-8",
    )
    return plugin_dir


class TestHookTranslation:
    def test_simple_session_start_hook(self, tmp_path: Path) -> None:
        hooks_data = {
            "hooks": {
                "SessionStart": [
                    {"hooks": [{"type": "command", "command": "echo hi", "timeout": 5}]}
                ]
            }
        }
        plugin_dir = _make_plugin_with_hooks(tmp_path, hooks_data)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        hooks = bundle.plugins["demo"].hooks
        assert len(hooks) == 1
        assert hooks[0].event == "SessionStart"
        assert hooks[0].command == "echo hi"
        assert hooks[0].timeout == 5

    def test_plugin_root_expansion(self, tmp_path: Path) -> None:
        hooks_data = {
            "hooks": {
                "PreToolUse": [
                    {
                        "hooks": [
                            {
                                "type": "command",
                                "command": "${CLAUDE_PLUGIN_ROOT}/scripts/check.sh",
                            }
                        ]
                    }
                ]
            }
        }
        plugin_dir = _make_plugin_with_hooks(tmp_path, hooks_data)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        hooks = bundle.plugins["demo"].hooks
        assert len(hooks) == 1
        assert str(plugin_dir) in hooks[0].command
        assert "${CLAUDE_PLUGIN_ROOT}" not in hooks[0].command

    def test_matcher_preserved(self, tmp_path: Path) -> None:
        hooks_data = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Shell",
                        "hooks": [{"type": "command", "command": "echo shell-guard"}],
                    }
                ]
            }
        }
        plugin_dir = _make_plugin_with_hooks(tmp_path, hooks_data)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert bundle.plugins["demo"].hooks[0].matcher == "Shell"

    def test_unsupported_event_warns(self, tmp_path: Path) -> None:
        hooks_data = {
            "hooks": {
                "FutureEvent": [
                    {"hooks": [{"type": "command", "command": "echo future"}]}
                ]
            }
        }
        plugin_dir = _make_plugin_with_hooks(tmp_path, hooks_data)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert len(bundle.plugins["demo"].hooks) == 0
        assert any("FutureEvent" in w for w in bundle.plugins["demo"].warnings)

    def test_unsupported_hook_type_warns(self, tmp_path: Path) -> None:
        hooks_data = {
            "hooks": {
                "SessionStart": [
                    {"hooks": [{"type": "webhook", "url": "https://example.com"}]}
                ]
            }
        }
        plugin_dir = _make_plugin_with_hooks(tmp_path, hooks_data)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert len(bundle.plugins["demo"].hooks) == 0
        assert any("webhook" in w for w in bundle.plugins["demo"].warnings)

    def test_invalid_hooks_json_warns(self, tmp_path: Path) -> None:
        plugin_dir = tmp_path / "demo"
        (plugin_dir / ".claude-plugin").mkdir(parents=True)
        (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "demo", "version": "1.0.0"}),
            encoding="utf-8",
        )
        hooks_dir = plugin_dir / "hooks"
        hooks_dir.mkdir()
        (hooks_dir / "hooks.json").write_text("not valid json", encoding="utf-8")

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert len(bundle.plugins["demo"].hooks) == 0
        assert any("Invalid" in w for w in bundle.plugins["demo"].warnings)

    def test_multiple_hooks_in_one_group(self, tmp_path: Path) -> None:
        hooks_data = {
            "hooks": {
                "SessionStart": [
                    {
                        "hooks": [
                            {"type": "command", "command": "echo first"},
                            {"type": "command", "command": "echo second"},
                        ]
                    }
                ]
            }
        }
        plugin_dir = _make_plugin_with_hooks(tmp_path, hooks_data)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert len(bundle.plugins["demo"].hooks) == 2

"""Tests for Claude plugin MCP config translation."""

from __future__ import annotations

import json
from pathlib import Path


def _make_plugin_with_mcp(
    tmp_path: Path,
    mcp_data: dict,
    plugin_name: str = "demo",
) -> Path:
    plugin_dir = tmp_path / plugin_name
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": plugin_name, "version": "1.0.0"}),
        encoding="utf-8",
    )
    (plugin_dir / ".mcp.json").write_text(
        json.dumps(mcp_data),
        encoding="utf-8",
    )
    return plugin_dir


class TestMCPTranslation:
    def test_mcp_servers_are_namespaced(self, tmp_path: Path) -> None:
        mcp_data = {
            "mcpServers": {
                "my-server": {
                    "transport": "stdio",
                    "command": "python",
                    "args": ["-m", "my_mcp_server"],
                }
            }
        }
        plugin_dir = _make_plugin_with_mcp(tmp_path, mcp_data)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        configs = bundle.plugins["demo"].mcp_configs
        assert len(configs) == 1
        servers = configs[0]["mcpServers"]
        assert "demo:my-server" in servers
        assert "my-server" not in servers

    def test_plugin_root_expansion_in_mcp(self, tmp_path: Path) -> None:
        mcp_data = {
            "mcpServers": {
                "local": {
                    "transport": "stdio",
                    "command": "${CLAUDE_PLUGIN_ROOT}/bin/server",
                    "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
                }
            }
        }
        plugin_dir = _make_plugin_with_mcp(tmp_path, mcp_data)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        configs = bundle.plugins["demo"].mcp_configs
        server = configs[0]["mcpServers"]["demo:local"]
        assert str(plugin_dir) in server["command"]
        assert "${CLAUDE_PLUGIN_ROOT}" not in server["command"]
        assert str(plugin_dir) in server["args"][1]

    def test_env_vars_in_mcp_config(self, tmp_path: Path) -> None:
        mcp_data = {
            "mcpServers": {
                "api": {
                    "transport": "stdio",
                    "command": "node",
                    "env": {"API_KEY": "${SOME_ENV_VAR}"},
                }
            }
        }
        plugin_dir = _make_plugin_with_mcp(tmp_path, mcp_data)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        configs = bundle.plugins["demo"].mcp_configs
        server = configs[0]["mcpServers"]["demo:api"]
        # Non-CLAUDE_PLUGIN_ROOT env vars should be preserved as-is
        assert server["env"]["API_KEY"] == "${SOME_ENV_VAR}"

    def test_no_mcp_json(self, tmp_path: Path) -> None:
        plugin_dir = tmp_path / "demo"
        (plugin_dir / ".claude-plugin").mkdir(parents=True)
        (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "demo", "version": "1.0.0"}),
            encoding="utf-8",
        )

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert len(bundle.plugins["demo"].mcp_configs) == 0

    def test_invalid_mcp_json_warns(self, tmp_path: Path) -> None:
        plugin_dir = tmp_path / "demo"
        (plugin_dir / ".claude-plugin").mkdir(parents=True)
        (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "demo", "version": "1.0.0"}),
            encoding="utf-8",
        )
        (plugin_dir / ".mcp.json").write_text("not json", encoding="utf-8")

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        assert len(bundle.plugins["demo"].mcp_configs) == 0
        assert any("Invalid" in w for w in bundle.plugins["demo"].warnings)

    def test_mcp_does_not_touch_global_config(self, tmp_path: Path) -> None:
        """Plugin MCP configs must never mutate persistent user config."""
        global_mcp = tmp_path / "share" / "mcp.json"
        global_mcp.parent.mkdir(parents=True)
        global_mcp.write_text('{"mcpServers":{}}', encoding="utf-8")

        mcp_data = {
            "mcpServers": {
                "plugin-server": {"transport": "stdio", "command": "echo"}
            }
        }
        plugin_dir = _make_plugin_with_mcp(tmp_path, mcp_data)

        from kimi_cli.claude_plugin.discovery import load_claude_plugins

        bundle = load_claude_plugins([plugin_dir])
        # Verify global file is unchanged
        assert json.loads(global_mcp.read_text()) == {"mcpServers": {}}
        # But plugin MCP configs exist in-memory
        assert len(bundle.plugins["demo"].mcp_configs) == 1

    def test_mcp_json_non_object_root_skips_mcp_not_plugin(self, tmp_path: Path) -> None:
        """.mcp.json with a non-object root (e.g. []) must not crash
        the entire plugin load."""
        plugin_dir = tmp_path / "demo"
        (plugin_dir / ".claude-plugin").mkdir(parents=True)
        (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "demo", "version": "1.0.0"}),
            encoding="utf-8",
        )
        (plugin_dir / ".mcp.json").write_text("[]", encoding="utf-8")

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
        assert len(bundle.plugins["demo"].mcp_configs) == 0
        assert any("not" in w.lower() or "dict" in w.lower() or "object" in w.lower()
                    for w in bundle.plugins["demo"].warnings)
        assert "demo:hello" in bundle.plugins["demo"].skills

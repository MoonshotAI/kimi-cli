"""Test OAuth scopes support in MCP commands."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from inline_snapshot import snapshot

from tests_e2e.wire_helpers import (
    base_command,
    make_env,
    make_home_dir,
    normalize_value,
    repo_root,
    share_dir,
)


def _normalize_cli_output(text: str) -> str:
    normalized = text
    normalized = normalize_value(normalized)
    normalized = normalized.replace("kimi-agent mcp", "<cmd> mcp")
    normalized = normalized.replace("kimi mcp", "<cmd> mcp")
    return normalized


def _run_cli(args: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    cmd = base_command() + args
    return subprocess.run(
        cmd,
        cwd=repo_root(),
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=30,
    )


def _mcp_config_path(home_dir: Path) -> Path:
    return share_dir(home_dir) / "mcp.json"


def _load_mcp_config(home_dir: Path) -> dict[str, object]:
    config_path = _mcp_config_path(home_dir)
    assert config_path.exists()
    data = json.loads(config_path.read_text(encoding="utf-8"))
    normalized = normalize_value(data)
    assert isinstance(normalized, dict)
    return normalized


def test_mcp_add_oauth_with_scopes(tmp_path: Path) -> None:
    """Test that --scope option is stored in config."""
    home_dir = make_home_dir(tmp_path)
    env = make_env(home_dir)

    # Add server with multiple scopes
    add = _run_cli(
        [
            "mcp",
            "add",
            "--transport",
            "http",
            "--auth",
            "oauth",
            "--scope",
            "organizations:read",
            "--scope",
            "projects:read",
            "--scope",
            "database:write",
            "supabase",
            "https://mcp.supabase.com/mcp",
        ],
        env,
    )

    assert add.returncode == 0, _normalize_cli_output(add.stderr)
    assert _normalize_cli_output(add.stdout) == snapshot(
        "Added MCP server 'supabase' to <home_dir>/.kimi/mcp.json.\n"
    )

    # Verify config has scopes
    config = _load_mcp_config(home_dir)
    assert config == snapshot(
        {
            "mcpServers": {
                "supabase": {
                    "auth": "oauth",
                    "scopes": ["organizations:read", "projects:read", "database:write"],
                    "transport": "http",
                    "url": "https://mcp.supabase.com/mcp",
                }
            }
        }
    )


def test_mcp_list_shows_scopes(tmp_path: Path) -> None:
    """Test that mcp list shows scopes."""
    home_dir = make_home_dir(tmp_path)
    env = make_env(home_dir)

    # Add server with scopes
    _run_cli(
        [
            "mcp",
            "add",
            "--transport",
            "http",
            "--auth",
            "oauth",
            "--scope",
            "read",
            "--scope",
            "write",
            "test",
            "https://example.com/mcp",
        ],
        env,
    )

    # List should show scopes
    listed = _run_cli(["mcp", "list"], env)
    assert listed.returncode == 0, _normalize_cli_output(listed.stderr)
    assert _normalize_cli_output(listed.stdout) == snapshot(
        """\
MCP config file: <home_dir>/.kimi/mcp.json
  test (http): https://example.com/mcp [scopes: read, write] [authorization required - run: <cmd> mcp auth test]
"""
    )

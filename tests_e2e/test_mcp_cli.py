from __future__ import annotations

import json
import subprocess
import sys
import textwrap
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


def _normalize_cli_output(text: str, *, replace: dict[str, str] | None = None) -> str:
    normalized = text
    if replace:
        for old, new in replace.items():
            if old and old in normalized:
                normalized = normalized.replace(old, new)
    normalized = normalize_value(normalized)
    normalized = normalized.replace("kagent mcp", "<cmd> mcp")
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


def _load_mcp_config(
    home_dir: Path, *, replacements: dict[str, str] | None = None
) -> dict[str, object]:
    config_path = _mcp_config_path(home_dir)
    assert config_path.exists()
    data = json.loads(config_path.read_text(encoding="utf-8"))
    normalized = normalize_value(data, replacements=replacements)
    assert isinstance(normalized, dict)
    return normalized


def test_mcp_stdio_management(tmp_path: Path) -> None:
    home_dir = make_home_dir(tmp_path)
    env = make_env(home_dir)

    server_path = tmp_path / "mcp_server.py"
    server_path.write_text(
        textwrap.dedent(
            """
            from fastmcp.server import FastMCP

            server = FastMCP("test-mcp")

            @server.tool
            def ping(text: str) -> str:
                \"\"\"pong the input text\"\"\"
                return f"pong:{text}"

            if __name__ == "__main__":
                server.run(transport="stdio", show_banner=False)
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    replacements = {
        str(sys.executable): "<python>",
        str(server_path): "<server>",
    }

    add = _run_cli(
        [
            "mcp",
            "add",
            "--transport",
            "stdio",
            "test",
            "--",
            sys.executable,
            str(server_path),
        ],
        env,
    )
    assert add.returncode == 0, _normalize_cli_output(add.stderr, replace=replacements)
    assert _normalize_cli_output(add.stdout, replace=replacements) == snapshot(
        "Added MCP server 'test' to <home_dir>/.kimi/mcp.json.\n"
    )
    assert _load_mcp_config(home_dir, replacements=replacements) == snapshot(
        {"mcpServers": {"test": {"args": ["<server>"], "command": "<python>"}}}
    )

    listed = _run_cli(["mcp", "list"], env)
    assert listed.returncode == 0, _normalize_cli_output(listed.stderr, replace=replacements)
    assert _normalize_cli_output(listed.stdout, replace=replacements) == snapshot(
        "MCP config file: <home_dir>/.kimi/mcp.json\n  test (stdio): <python> <server>\n"
    )

    tested = _run_cli(["mcp", "test", "test"], env)
    assert tested.returncode == 0, _normalize_cli_output(tested.stderr, replace=replacements)
    assert _normalize_cli_output(tested.stdout, replace=replacements) == snapshot(
        "Testing connection to 'test'...\n✓ Connected to 'test'\n  Available tools: 1\n  Tools:\n    - ping: pong the input text\n"
    )

    removed = _run_cli(["mcp", "remove", "test"], env)
    assert removed.returncode == 0, _normalize_cli_output(removed.stderr, replace=replacements)
    assert _normalize_cli_output(removed.stdout, replace=replacements) == snapshot(
        "Removed MCP server 'test' from <home_dir>/.kimi/mcp.json.\n"
    )
    assert _load_mcp_config(home_dir, replacements=replacements) == snapshot({"mcpServers": {}})

    listed_empty = _run_cli(["mcp", "list"], env)
    assert listed_empty.returncode == 0, _normalize_cli_output(
        listed_empty.stderr, replace=replacements
    )
    assert _normalize_cli_output(listed_empty.stdout, replace=replacements) == snapshot(
        "MCP config file: <home_dir>/.kimi/mcp.json\nNo MCP servers configured.\n"
    )


def test_mcp_http_management_and_auth_errors(tmp_path: Path) -> None:
    home_dir = make_home_dir(tmp_path)
    env = make_env(home_dir)
    replacements = {str(sys.executable): "<python>"}

    add_http = _run_cli(
        [
            "mcp",
            "add",
            "--transport",
            "http",
            "remote",
            "https://example.com/mcp",
            "--header",
            "X-Test: 1",
        ],
        env,
    )
    assert add_http.returncode == 0, _normalize_cli_output(add_http.stderr)
    assert _normalize_cli_output(add_http.stdout) == snapshot(
        "Added MCP server 'remote' to <home_dir>/.kimi/mcp.json.\n"
    )
    assert _load_mcp_config(home_dir, replacements=replacements) == snapshot(
        {
            "mcpServers": {
                "remote": {
                    "headers": {"X-Test": "1"},
                    "transport": "http",
                    "url": "https://example.com/mcp",
                }
            }
        }
    )

    add_oauth = _run_cli(
        [
            "mcp",
            "add",
            "--transport",
            "http",
            "--auth",
            "oauth",
            "oauth",
            "https://example.com/oauth",
        ],
        env,
    )
    assert add_oauth.returncode == 0, _normalize_cli_output(add_oauth.stderr)
    assert _normalize_cli_output(add_oauth.stdout) == snapshot(
        "Added MCP server 'oauth' to <home_dir>/.kimi/mcp.json.\n"
    )
    assert _load_mcp_config(home_dir, replacements=replacements) == snapshot(
        {
            "mcpServers": {
                "oauth": {
                    "auth": "oauth",
                    "transport": "http",
                    "url": "https://example.com/oauth",
                },
                "remote": {
                    "headers": {"X-Test": "1"},
                    "transport": "http",
                    "url": "https://example.com/mcp",
                },
            }
        }
    )

    list_http = _run_cli(["mcp", "list"], env)
    assert list_http.returncode == 0, _normalize_cli_output(list_http.stderr)
    assert _normalize_cli_output(list_http.stdout) == snapshot(
        "MCP config file: <home_dir>/.kimi/mcp.json\n  remote (http): https://example.com/mcp\n  oauth (http): https://example.com/oauth [authorization required - run: <cmd> mcp auth oauth]\n"
    )

    auth_http = _run_cli(["mcp", "auth", "remote"], env)
    assert auth_http.returncode != 0
    assert _normalize_cli_output(auth_http.stderr) == snapshot(
        "MCP server 'remote' does not use OAuth. Add with --auth oauth.\n"
    )

    reset_http = _run_cli(["mcp", "reset-auth", "remote"], env)
    assert reset_http.returncode == 0, _normalize_cli_output(reset_http.stderr)
    assert _normalize_cli_output(reset_http.stdout) == snapshot(
        "OAuth tokens cleared for 'remote'.\n"
    )

    auth_stdio = _run_cli(
        [
            "mcp",
            "add",
            "--transport",
            "stdio",
            "local",
            "--",
            sys.executable,
            "-c",
            "print('noop')",
        ],
        env,
    )
    assert auth_stdio.returncode == 0, _normalize_cli_output(auth_stdio.stderr)
    assert _load_mcp_config(home_dir, replacements=replacements) == snapshot(
        {
            "mcpServers": {
                "local": {"args": ["-c", "print('noop')"], "command": "<python>"},
                "oauth": {
                    "auth": "oauth",
                    "transport": "http",
                    "url": "https://example.com/oauth",
                },
                "remote": {
                    "headers": {"X-Test": "1"},
                    "transport": "http",
                    "url": "https://example.com/mcp",
                },
            }
        }
    )

    auth_stdio = _run_cli(["mcp", "auth", "local"], env)
    assert auth_stdio.returncode != 0
    assert _normalize_cli_output(auth_stdio.stderr) == snapshot(
        "MCP server 'local' is not a remote server.\n"
    )

    reset_stdio = _run_cli(["mcp", "reset-auth", "local"], env)
    assert reset_stdio.returncode != 0
    assert _normalize_cli_output(reset_stdio.stderr) == snapshot(
        "MCP server 'local' is not a remote server.\n"
    )

    remove_missing = _run_cli(["mcp", "remove", "missing"], env)
    assert remove_missing.returncode != 0
    assert _normalize_cli_output(remove_missing.stderr) == snapshot(
        "MCP server 'missing' not found.\n"
    )

"""Tests for kimi mcp add/auth --scope feature."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any
from unittest.mock import AsyncMock, patch

from fastmcp.client.auth.oauth import OAuth
from typer.testing import CliRunner

from kimi_cli.cli.mcp import cli

_runner = CliRunner()

_EXAMPLE_URL = "https://mcp.example.com/mcp"


@contextmanager
def _patch_mcp_config(initial: dict[str, Any] | None = None):
    """Patch load/save so tests never touch the real config file.

    Yields a list that captures whatever was passed to _save_mcp_config.
    """
    saved: list[dict[str, Any]] = []
    with patch.multiple(
        "kimi_cli.cli.mcp",
        _load_mcp_config=lambda: initial or {"mcpServers": {}},
        _save_mcp_config=lambda config: saved.append(config),
    ):
        yield saved


def _make_oauth_server(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"url": _EXAMPLE_URL, "transport": "http", "auth": "oauth"}
    base.update(overrides)
    return base


def _mock_fastmcp_client():
    """Return a mock fastmcp.Client that supports `async with`."""
    mock_instance = AsyncMock()
    mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
    mock_instance.__aexit__ = AsyncMock(return_value=False)
    mock_instance.list_tools = AsyncMock(return_value=[])
    return mock_instance


# --- mcp add: --scope rejected for stdio transport ---


def test_add_scope_rejected_for_stdio() -> None:
    with _patch_mcp_config():
        result = _runner.invoke(
            cli,
            ["add", "-t", "stdio", "-s", "read", "myserver", "--", "npx", "srv"],
        )
    assert result.exit_code != 0
    assert "--scope is only valid for http transport" in result.output


def test_add_stdio_header_checked_before_scope() -> None:
    with _patch_mcp_config():
        result = _runner.invoke(
            cli,
            ["add", "-t", "stdio", "-H", "X-Key:val", "-s", "read", "myserver", "--", "npx", "srv"],
        )
    assert result.exit_code != 0
    assert "--header is only valid for http transport" in result.output


# --- mcp add: --scope requires --auth oauth ---


def test_add_scope_rejected_without_auth() -> None:
    with _patch_mcp_config():
        result = _runner.invoke(
            cli,
            ["add", "-t", "http", "-s", "read", "myserver", _EXAMPLE_URL],
        )
    assert result.exit_code != 0
    assert "--scope is only valid with --auth oauth" in result.output


def test_add_scope_rejected_with_non_oauth_auth() -> None:
    with _patch_mcp_config():
        result = _runner.invoke(
            cli,
            ["add", "-t", "http", "-a", "basic", "-s", "read", "myserver", _EXAMPLE_URL],
        )
    assert result.exit_code != 0
    assert "--scope is only valid with --auth oauth" in result.output


def test_add_scope_accepted_with_auth_oauth() -> None:
    with _patch_mcp_config():
        result = _runner.invoke(
            cli,
            [
                "add",
                "-t",
                "http",
                "-a",
                "oauth",
                "-s",
                "read",
                "-s",
                "write",
                "myserver",
                _EXAMPLE_URL,
            ],
        )
    assert result.exit_code == 0
    assert "Added MCP server 'myserver'" in result.output


def test_add_no_scope_still_works() -> None:
    with _patch_mcp_config():
        result = _runner.invoke(
            cli,
            ["add", "-t", "http", "-a", "oauth", "myserver", _EXAMPLE_URL],
        )
    assert result.exit_code == 0
    assert "Added MCP server 'myserver'" in result.output


# --- mcp add: config persistence ---


def test_add_scopes_stored_as_list() -> None:
    with _patch_mcp_config() as saved:
        result = _runner.invoke(
            cli,
            [
                "add",
                "-t",
                "http",
                "-a",
                "oauth",
                "-s",
                "organizations:read",
                "-s",
                "projects:read",
                "supabase",
                "https://mcp.supabase.com/mcp",
            ],
        )
    assert result.exit_code == 0
    server = saved[0]["mcpServers"]["supabase"]
    assert server["scopes"] == ["organizations:read", "projects:read"]
    assert server["auth"] == "oauth"


def test_add_no_scopes_key_when_omitted() -> None:
    with _patch_mcp_config() as saved:
        result = _runner.invoke(
            cli,
            ["add", "-t", "http", "-a", "oauth", "linear", "https://mcp.linear.app/mcp"],
        )
    assert result.exit_code == 0
    server = saved[0]["mcpServers"]["linear"]
    assert "scopes" not in server


# --- mcp auth: transport + OAuth construction ---


@patch("kimi_cli.cli.mcp._get_mcp_server")
@patch("kimi_cli.cli.mcp._load_mcp_config")
def test_auth_with_scopes_creates_oauth_with_scopes(mock_load: Any, mock_get: Any) -> None:
    mock_get.return_value = _make_oauth_server(scopes=["read", "write"])

    with (
        patch("fastmcp.Client") as mock_client,
        patch("fastmcp.client.transports.StreamableHttpTransport") as mock_transport,
    ):
        mock_client.return_value = _mock_fastmcp_client()
        result = _runner.invoke(cli, ["auth", "supabase"])

    assert result.exit_code == 0
    mock_transport.assert_called_once()
    call_args = mock_transport.call_args
    # Transport called with (url, headers=..., auth=...)
    assert call_args[0][0] == _EXAMPLE_URL  # positional arg: url
    assert call_args[1].get("headers") == {}
    oauth_arg = call_args[1].get("auth")
    assert isinstance(oauth_arg, OAuth)
    assert oauth_arg.context.client_metadata.scope == "read write"
    assert oauth_arg.context.server_url == _EXAMPLE_URL


@patch("kimi_cli.cli.mcp._get_mcp_server")
@patch("kimi_cli.cli.mcp._load_mcp_config")
def test_auth_without_scopes_creates_oauth_with_empty_scope(mock_load: Any, mock_get: Any) -> None:
    mock_get.return_value = _make_oauth_server()

    with (
        patch("fastmcp.Client") as mock_client,
        patch("fastmcp.client.transports.StreamableHttpTransport") as mock_transport,
    ):
        mock_client.return_value = _mock_fastmcp_client()
        result = _runner.invoke(cli, ["auth", "linear"])

    assert result.exit_code == 0
    mock_transport.assert_called_once()
    call_args = mock_transport.call_args
    oauth_arg = call_args[1].get("auth")
    assert isinstance(oauth_arg, OAuth)
    assert oauth_arg.context.client_metadata.scope == ""
    assert oauth_arg.context.server_url == _EXAMPLE_URL


@patch("kimi_cli.cli.mcp._get_mcp_server")
@patch("kimi_cli.cli.mcp._load_mcp_config")
def test_auth_sse_transport_uses_sse_class(mock_load: Any, mock_get: Any) -> None:
    mock_get.return_value = _make_oauth_server(transport="sse", scopes=["read"])

    with (
        patch("fastmcp.Client") as mock_client,
        patch("fastmcp.client.transports.SSETransport") as mock_sse,
    ):
        mock_client.return_value = _mock_fastmcp_client()
        result = _runner.invoke(cli, ["auth", "myserver"])

    assert result.exit_code == 0
    mock_sse.assert_called_once()
    call_args = mock_sse.call_args
    oauth_arg = call_args[1].get("auth")
    assert isinstance(oauth_arg, OAuth)
    assert oauth_arg.context.client_metadata.scope == "read"


@patch("kimi_cli.cli.mcp._get_mcp_server")
@patch("kimi_cli.cli.mcp._load_mcp_config")
def test_auth_passes_headers_from_config(mock_load: Any, mock_get: Any) -> None:
    mock_get.return_value = _make_oauth_server(headers={"X-Api-Key": "secret"})

    with (
        patch("fastmcp.Client") as mock_client,
        patch("fastmcp.client.transports.StreamableHttpTransport") as mock_transport,
    ):
        mock_client.return_value = _mock_fastmcp_client()
        result = _runner.invoke(cli, ["auth", "myserver"])

    assert result.exit_code == 0
    mock_transport.assert_called_once()
    call_args = mock_transport.call_args
    assert call_args[1].get("headers") == {"X-Api-Key": "secret"}


@patch("kimi_cli.cli.mcp._get_mcp_server")
@patch("kimi_cli.cli.mcp._load_mcp_config")
def test_auth_fixes_server_url_to_full_mcp_url(mock_load: Any, mock_get: Any) -> None:
    """Verify _OAuth patches context.server_url to include the full path (RFC 8707 fix)."""
    mock_get.return_value = _make_oauth_server(scopes=["read"])

    with (
        patch("fastmcp.Client") as mock_client,
        patch("fastmcp.client.transports.StreamableHttpTransport") as mock_transport,
    ):
        mock_client.return_value = _mock_fastmcp_client()
        result = _runner.invoke(cli, ["auth", "myserver"])

    assert result.exit_code == 0
    call_args = mock_transport.call_args
    oauth_arg = call_args[1].get("auth")
    # fastmcp's OAuth.__init__ strips URL path; our patched client preserves it.
    assert oauth_arg.context.server_url == _EXAMPLE_URL

from __future__ import annotations

import warnings
from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_mcp_oauth_storage_persists_tokens_in_share_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

    from mcp.shared.auth import OAuthToken

    from kimi_cli.mcp_oauth import create_mcp_oauth_token_storage, has_mcp_oauth_tokens

    server_url = "https://mcp.example.test/mcp/"

    storage = create_mcp_oauth_token_storage(server_url)

    assert (tmp_path / "mcp-oauth").is_dir()
    assert not await has_mcp_oauth_tokens(server_url)

    await storage.set_tokens(OAuthToken(access_token="access", refresh_token="refresh"))

    assert await has_mcp_oauth_tokens(server_url)

    fresh_storage = create_mcp_oauth_token_storage(server_url)
    tokens = await fresh_storage.get_tokens()
    assert tokens is not None
    assert tokens.access_token == "access"
    assert tokens.refresh_token == "refresh"

    await fresh_storage.clear()
    assert not await has_mcp_oauth_tokens(server_url)


@pytest.mark.asyncio
async def test_has_mcp_oauth_tokens_treats_unreadable_storage_as_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    (tmp_path / "mcp-oauth").write_text("not a directory", encoding="utf-8")

    from kimi_cli.mcp_oauth import has_mcp_oauth_tokens

    assert not await has_mcp_oauth_tokens("https://mcp.example.test/mcp")


def test_create_mcp_oauth_uses_persistent_storage_without_warning(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

    from fastmcp.client.auth.oauth import OAuth, TokenStorageAdapter

    from kimi_cli.mcp_oauth import create_mcp_oauth

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        auth = create_mcp_oauth("https://mcp.example.test/mcp")

    assert isinstance(auth, OAuth)
    assert isinstance(auth.token_storage_adapter, TokenStorageAdapter)
    assert not any("in-memory token storage" in str(warning.message) for warning in caught)


def test_create_mcp_oauth_forwards_scopes(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

    from kimi_cli.mcp_oauth import create_mcp_oauth

    auth = create_mcp_oauth("https://mcp.example.test/mcp", scopes=["read", "write"])

    assert auth.context.client_metadata.scope == "read write"
    assert auth.context.server_url == "https://mcp.example.test/mcp"


def test_prepare_mcp_server_config_replaces_oauth_literal_without_mutating(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

    from fastmcp.client.auth.oauth import OAuth

    from kimi_cli.mcp_oauth import prepare_mcp_server_config

    server = {
        "url": "https://mcp.example.test/mcp",
        "transport": "http",
        "headers": {"x-test": "yes"},
        "auth": "oauth",
    }

    prepared = prepare_mcp_server_config(server)

    assert server["auth"] == "oauth"
    assert prepared["headers"] == {"x-test": "yes"}
    assert isinstance(prepared["auth"], OAuth)


def test_prepare_mcp_server_config_forwards_scopes(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

    from kimi_cli.mcp_oauth import prepare_mcp_server_config

    server = {
        "url": "https://mcp.example.test/mcp",
        "transport": "http",
        "auth": "oauth",
        "scopes": ["organizations:read", "projects:read"],
    }

    prepared = prepare_mcp_server_config(server)

    assert server["auth"] == "oauth"
    assert prepared["scopes"] == server["scopes"]
    assert prepared["auth"].context.client_metadata.scope == "organizations:read projects:read"


def test_prepare_mcp_server_config_preserves_url_transport_inference(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

    from fastmcp.client.transports import SSETransport
    from fastmcp.mcp_config import MCPConfig

    from kimi_cli.mcp_oauth import prepare_mcp_server_config

    prepared = prepare_mcp_server_config(
        {
            "url": "https://mcp.example.test/sse",
            "auth": "oauth",
            "scopes": ["read"],
        }
    )
    config = MCPConfig.model_validate({"mcpServers": {"server": prepared}})
    remote = config.mcpServers["server"]

    assert remote.transport is None
    assert isinstance(remote.to_transport(), SSETransport)


def test_prepare_mcp_server_config_rejects_non_string_scopes(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

    from kimi_cli.mcp_oauth import prepare_mcp_server_config

    with pytest.raises(ValueError, match="list of strings"):
        prepare_mcp_server_config(
            {
                "url": "https://mcp.example.test/mcp",
                "auth": "oauth",
                "scopes": ["read", 1],
            }
        )


@pytest.mark.asyncio
async def test_patched_oauth_skips_preflight_request(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

    from kimi_cli.mcp_oauth import create_mcp_oauth

    auth = create_mcp_oauth("https://mcp.example.test/mcp")
    with patch("webbrowser.open") as open_browser:
        await auth.redirect_handler("https://auth.example.test/authorize")

    open_browser.assert_called_once_with("https://auth.example.test/authorize")


@pytest.mark.asyncio
async def test_patched_oauth_accepts_created_token_response(tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))

    from fastmcp.client.auth.oauth import OAuth

    from kimi_cli.mcp_oauth import create_mcp_oauth

    auth = create_mcp_oauth("https://mcp.example.test/mcp")
    base_handler = AsyncMock()
    with patch.object(OAuth, "_handle_token_response", base_handler):
        response = type("Response", (), {"status_code": 201})()
        await auth._handle_token_response(response)

    assert response.status_code == 200
    base_handler.assert_awaited_once_with(response)


@pytest.mark.asyncio
async def test_load_mcp_tools_treats_unreadable_oauth_storage_as_unauthorized(
    tmp_path, monkeypatch, runtime
):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    (tmp_path / "mcp-oauth").write_text("not a directory", encoding="utf-8")

    from fastmcp.mcp_config import MCPConfig

    from kimi_cli.soul.toolset import KimiToolset

    toolset = KimiToolset()
    mcp_config = MCPConfig.model_validate(
        {
            "mcpServers": {
                "linear": {
                    "url": "https://mcp.example.test/mcp",
                    "transport": "http",
                    "auth": "oauth",
                }
            }
        }
    )

    await toolset.load_mcp_tools([mcp_config], runtime, in_background=False)

    snapshot = toolset.mcp_status_snapshot()
    assert snapshot is not None
    assert snapshot.connected == 0
    assert snapshot.total == 1
    assert snapshot.tools == 0
    assert [(server.name, server.status) for server in snapshot.servers] == [
        ("linear", "unauthorized")
    ]

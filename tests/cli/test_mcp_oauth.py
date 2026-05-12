from __future__ import annotations

import warnings

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

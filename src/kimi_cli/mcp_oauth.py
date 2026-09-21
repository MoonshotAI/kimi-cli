from __future__ import annotations

from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kimi_cli.share import get_share_dir

if TYPE_CHECKING:
    from fastmcp.client.auth.oauth import OAuth, TokenStorageAdapter
    from key_value.aio.stores.filetree import FileTreeStore


def _mcp_oauth_dir() -> Path:
    path = get_share_dir() / "mcp-oauth"
    path.mkdir(parents=True, exist_ok=True)
    with suppress(OSError):
        path.chmod(0o700)
    return path


def create_mcp_oauth_store() -> FileTreeStore:
    from key_value.aio.stores.filetree import (
        FileTreeStore,
        FileTreeV1CollectionSanitizationStrategy,
        FileTreeV1KeySanitizationStrategy,
    )

    storage_dir = _mcp_oauth_dir()
    return FileTreeStore(
        data_directory=storage_dir,
        key_sanitization_strategy=FileTreeV1KeySanitizationStrategy(storage_dir),
        collection_sanitization_strategy=FileTreeV1CollectionSanitizationStrategy(storage_dir),
    )


def create_mcp_oauth_token_storage(server_url: str) -> TokenStorageAdapter:
    from fastmcp.client.auth.oauth import TokenStorageAdapter

    return TokenStorageAdapter(create_mcp_oauth_store(), server_url.rstrip("/"))


async def has_mcp_oauth_tokens(server_url: str) -> bool:
    try:
        storage = create_mcp_oauth_token_storage(server_url)
        return await storage.get_tokens() is not None
    except Exception as exc:
        from kimi_cli import logger

        logger.debug(
            "Failed to read MCP OAuth tokens for {server_url}: {error}",
            server_url=server_url,
            error=exc,
        )
        return False


def create_mcp_oauth(server_url: str, scopes: list[str] | None = None) -> OAuth:
    from fastmcp.client.auth.oauth import OAuth

    if scopes is not None and (
        not isinstance(scopes, list) or any(not isinstance(scope, str) for scope in scopes)
    ):
        raise ValueError("OAuth MCP server scopes must be a list of strings.")

    class _PatchedOAuth(OAuth):
        """Apply compatibility workarounds for MCP OAuth providers.

        FastMCP 3.2.4 still performs a pre-flight authorization request that
        treats HTTP 400 as an invalid client, and only accepts HTTP 200 from
        the token endpoint. Some MCP providers use HTTP 400 for the normal
        login page and HTTP 201 for a successful token exchange.
        """

        async def redirect_handler(self, authorization_url: str) -> None:
            import webbrowser

            webbrowser.open(authorization_url)

        async def _handle_token_response(self, response: Any) -> None:
            if response.status_code == 201:
                response.status_code = 200
            await super()._handle_token_response(response)

    return _PatchedOAuth(
        mcp_url=server_url,
        scopes=scopes,
        token_storage=create_mcp_oauth_store(),
    )


def prepare_mcp_server_config(server_config: dict[str, Any]) -> dict[str, Any]:
    if server_config.get("auth") != "oauth":
        return server_config

    server_url = server_config.get("url")
    if not isinstance(server_url, str) or not server_url:
        raise ValueError("OAuth MCP server config must include a non-empty URL.")

    scopes = server_config.get("scopes")
    return {**server_config, "auth": create_mcp_oauth(server_url, scopes=scopes)}

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


def create_mcp_oauth(server_url: str) -> OAuth:
    from fastmcp.client.auth.oauth import OAuth

    return OAuth(mcp_url=server_url, token_storage=create_mcp_oauth_store())


def prepare_mcp_server_config(server_config: dict[str, Any]) -> dict[str, Any]:
    if server_config.get("auth") != "oauth":
        return server_config

    server_url = server_config.get("url")
    if not isinstance(server_url, str) or not server_url:
        raise ValueError("OAuth MCP server config must include a non-empty URL.")

    return {**server_config, "auth": create_mcp_oauth(server_url)}

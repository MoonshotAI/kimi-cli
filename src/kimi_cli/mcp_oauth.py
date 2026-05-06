from __future__ import annotations

from pathlib import Path

from fastmcp.client.auth.oauth import OAuth, TokenStorageAdapter
from key_value.aio.protocols import AsyncKeyValue
from key_value.aio.stores.filetree import (
    FileTreeStore,
    FileTreeV1CollectionSanitizationStrategy,
    FileTreeV1KeySanitizationStrategy,
)

from kimi_cli.share import get_share_dir


def _normalize_server_url(server_url: str) -> str:
    return server_url.rstrip("/")


def _oauth_storage_root() -> Path:
    return get_share_dir() / "mcp-oauth"


def _oauth_token_store() -> AsyncKeyValue:
    root = _oauth_storage_root()
    root.mkdir(parents=True, exist_ok=True)
    return FileTreeStore(
        data_directory=root,
        collection_sanitization_strategy=FileTreeV1CollectionSanitizationStrategy(root),
        key_sanitization_strategy=FileTreeV1KeySanitizationStrategy(root),
    )


def build_mcp_oauth(server_url: str) -> OAuth:
    return OAuth(_normalize_server_url(server_url), token_storage=_oauth_token_store())


async def has_mcp_oauth_tokens(server_url: str) -> bool:
    try:
        storage = TokenStorageAdapter(
            _oauth_token_store(), server_url=_normalize_server_url(server_url)
        )
        return await storage.get_tokens() is not None
    except Exception:
        return False


async def clear_mcp_oauth_tokens(server_url: str) -> None:
    storage = TokenStorageAdapter(
        _oauth_token_store(), server_url=_normalize_server_url(server_url)
    )
    await storage.clear()

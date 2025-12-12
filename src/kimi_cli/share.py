from __future__ import annotations

from pathlib import Path


def get_share_dir() -> Path:
    """Get the share directory path."""
    share_dir = Path.home() / ".kimi"
    share_dir.mkdir(parents=True, exist_ok=True)
    return share_dir


def get_default_mcp_config_file() -> Path:
    """Get the default MCP config file path (~/.kimi/mcp.json)."""
    return get_share_dir() / "mcp.json"

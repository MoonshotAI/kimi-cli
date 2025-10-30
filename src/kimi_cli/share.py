import os
from functools import lru_cache
from pathlib import Path


@lru_cache
def _resolve_share_dir() -> Path:
    """Resolve the base directory for Kimi share data."""
    env_dir = os.getenv("KIMI_SHARE_DIR")
    if env_dir:
        return Path(env_dir).expanduser()
    return Path.home() / ".kimi"


def get_share_dir() -> Path:
    """Get the share directory path."""
    share_dir = _resolve_share_dir()
    share_dir.mkdir(parents=True, exist_ok=True)
    return share_dir

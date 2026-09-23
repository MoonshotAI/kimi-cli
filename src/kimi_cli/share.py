from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def get_share_dir() -> Path:
    """Return the Kimi share directory, creating it if necessary."""
    share_dir = Path(os.environ.get("KIMI_SHARE_DIR", "~/.kimi")).expanduser()
    share_dir.mkdir(parents=True, exist_ok=True)
    return share_dir

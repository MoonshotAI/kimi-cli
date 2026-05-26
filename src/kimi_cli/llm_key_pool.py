"""API key pool for parallel subagent execution.

When a user configures multiple API keys (e.g. ``KIMI_API_KEY``,
``KIMI_API_KEY_1``, ``KIMI_API_KEY_2``), each foreground/background
subagent can be assigned a different key so that concurrent LLM
requests do not hammer a single key's rate-limit quota.

If only one key is available (the default via ``/login`` or a single
env var) the pool is ``None`` and every subagent falls back to the
root runtime's key — behaviour is unchanged.
"""

from __future__ import annotations

import os
from collections.abc import Sequence


class APIKeyPool:
    """Round-robin API key pool.

    Thread-safe for asyncio because a single event loop handles all
    subagent creation (``SubagentBuilder`` runs on the main loop).
    """

    def __init__(self, keys: Sequence[str]) -> None:
        if not keys:
            raise ValueError("Key pool cannot be empty")
        self._keys = list(keys)
        self._index = 0

    @classmethod
    def from_env(cls, prefix: str = "KIMI_API_KEY") -> APIKeyPool | None:
        """Build a pool from environment variables.

        Collects ``PREFIX``, ``PREFIX_1``, ``PREFIX_2``, … in that
        order.  Returns ``None`` when fewer than two keys are found,
        because a pool with a single key provides no parallelism
        benefit and the normal code path already handles that.
        """
        keys: list[str] = []
        primary = os.getenv(prefix)
        if primary:
            keys.append(primary)
        # Look for numbered suffixes up to a reasonable bound.
        for i in range(1, 100):
            val = os.getenv(f"{prefix}_{i}")
            if val:
                keys.append(val)
        if len(keys) < 2:
            return None
        return cls(keys)

    @property
    def key_count(self) -> int:
        return len(self._keys)

    def acquire(self) -> str:
        """Return the next key in round-robin order."""
        key = self._keys[self._index]
        self._index = (self._index + 1) % len(self._keys)
        return key

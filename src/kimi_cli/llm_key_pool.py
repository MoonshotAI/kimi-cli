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
import time
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass
class _KeyState:
    """Tracks the health of a single pooled key."""

    consecutive_failures: int = 0
    cooldown_until: float | None = None


class APIKeyPool:
    """Round-robin API key pool with exponential cooldown.

    Thread-safe for asyncio because a single event loop handles all
    subagent creation (``SubagentBuilder`` runs on the main loop).
    """

    def __init__(self, keys: Sequence[str]) -> None:
        if not keys:
            raise ValueError("Key pool cannot be empty")
        self._keys = list(keys)
        self._index = 0
        self._states: dict[str, _KeyState] = {k: _KeyState() for k in self._keys}

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
        """Return the next healthy key, skipping keys in cooldown.

        If every key is in cooldown, falls back to round-robin so that
        tenacity retries can still attempt recovery.
        """
        now = time.time()
        for _ in range(len(self._keys)):
            key = self._keys[self._index]
            self._index = (self._index + 1) % len(self._keys)
            state = self._states[key]
            if state.cooldown_until is not None:
                if now < state.cooldown_until:
                    continue
                # Cooldown expired — reset the key to healthy.
                self._states[key] = _KeyState()
            return key
        # All keys in cooldown — fall back to round-robin across the pool.
        key = self._keys[self._index]
        self._index = (self._index + 1) % len(self._keys)
        return key

    def record_failure(self, key: str) -> None:
        """Record a retryable failure for *key* and apply exponential cooldown.

        Cooldown schedule: 30s → 5min → 30min.
        """
        state = self._states[key]
        failures = state.consecutive_failures + 1
        if failures == 1:
            cooldown = 30.0
        elif failures == 2:
            cooldown = 300.0
        else:
            cooldown = 1800.0
        self._states[key] = _KeyState(
            consecutive_failures=failures,
            cooldown_until=time.time() + cooldown,
        )

    def reset_key(self, key: str) -> None:
        """Reset the failure state for *key* (e.g. after a successful request)."""
        self._states[key] = _KeyState()

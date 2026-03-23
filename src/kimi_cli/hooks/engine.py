from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Callable
from typing import Any

from kimi_cli import logger
from kimi_cli.hooks.config import HookDef, HookEventType
from kimi_cli.hooks.runner import HookResult, run_hook

# Callback signatures for wire integration
type OnTriggered = Callable[[str, str, int], None]
"""(event, target, hook_count) -> None"""

type OnResolved = Callable[[str, str, str, str, int], None]
"""(event, target, action, reason, duration_ms) -> None"""


class HookEngine:
    """Loads hook definitions and executes matching hooks in parallel."""

    def __init__(
        self,
        hooks: list[HookDef] | None = None,
        cwd: str | None = None,
        *,
        on_triggered: OnTriggered | None = None,
        on_resolved: OnResolved | None = None,
    ):
        self._hooks: list[HookDef] = list(hooks) if hooks else []
        self._cwd = cwd
        self._on_triggered = on_triggered
        self._on_resolved = on_resolved
        self._by_event: dict[str, list[HookDef]] = {}
        self._rebuild_index()

    def _rebuild_index(self) -> None:
        self._by_event.clear()
        for h in self._hooks:
            self._by_event.setdefault(h.event, []).append(h)

    def add_hooks(self, hooks: list[HookDef]) -> None:
        """Add hooks at runtime (e.g. from wire client). Rebuilds index."""
        self._hooks.extend(hooks)
        self._rebuild_index()

    def set_callbacks(
        self,
        on_triggered: OnTriggered | None = None,
        on_resolved: OnResolved | None = None,
    ) -> None:
        """Set wire event callbacks. Called once after engine is wired to the soul."""
        self._on_triggered = on_triggered
        self._on_resolved = on_resolved

    @property
    def has_hooks(self) -> bool:
        return bool(self._hooks)

    def has_hooks_for(self, event: HookEventType) -> bool:
        return bool(self._by_event.get(event))

    @property
    def summary(self) -> dict[str, int]:
        """Event -> count of configured hooks."""
        return {event: len(hooks) for event, hooks in self._by_event.items()}

    async def trigger(
        self,
        event: HookEventType,
        *,
        matcher_value: str = "",
        input_data: dict[str, Any],
    ) -> list[HookResult]:
        """Run all matching hooks for an event in parallel. Dedup identical commands."""
        candidates = self._by_event.get(event, [])
        if not candidates:
            return []

        seen: set[str] = set()
        matched: list[HookDef] = []
        for h in candidates:
            if h.matcher:
                try:
                    if not re.search(h.matcher, matcher_value):
                        continue
                except re.error:
                    logger.warning("Invalid regex in hook matcher: {}", h.matcher)
                    continue
            if h.command in seen:
                continue
            seen.add(h.command)
            matched.append(h)

        if not matched:
            return []

        logger.debug("Triggering {} hooks for {}", len(matched), event)

        # --- HookTriggered ---
        if self._on_triggered:
            self._on_triggered(event, matcher_value, len(matched))

        t0 = time.monotonic()
        tasks = [run_hook(h.command, input_data, timeout=h.timeout, cwd=self._cwd) for h in matched]
        results = list(await asyncio.gather(*tasks))
        duration_ms = int((time.monotonic() - t0) * 1000)

        # Aggregate: block if any hook blocked
        action = "allow"
        reason = ""
        for r in results:
            if r.action == "block":
                action = "block"
                reason = r.reason
                break

        # --- HookResolved ---
        if self._on_resolved:
            self._on_resolved(event, matcher_value, action, reason, duration_ms)

        return results

from __future__ import annotations

import asyncio
import re
from typing import Any

from kimi_cli import logger
from kimi_cli.hooks.config import HookDef, HookEventType
from kimi_cli.hooks.runner import HookResult, run_hook


class HookEngine:
    """Loads hook definitions and executes matching hooks in parallel."""

    def __init__(self, hooks: list[HookDef], cwd: str | None = None):
        self._hooks = hooks
        self._cwd = cwd
        # Index by event for fast lookup
        self._by_event: dict[str, list[HookDef]] = {}
        for h in hooks:
            self._by_event.setdefault(h.event, []).append(h)

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
                    continue  # bad regex -> skip this hook (fail-open)
            if h.command in seen:
                continue
            seen.add(h.command)
            matched.append(h)

        if not matched:
            return []

        logger.debug("Triggering {} hooks for {}", len(matched), event)
        tasks = [run_hook(h.command, input_data, timeout=h.timeout, cwd=self._cwd) for h in matched]
        return list(await asyncio.gather(*tasks))

from __future__ import annotations

import asyncio
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from kimi_cli import logger
from kimi_cli.hooks.config import HookDef, HookEventType
from kimi_cli.hooks.runner import HookResult, run_hook

# Callback signatures for wire integration
type OnTriggered = Callable[[str, str, int], None]
"""(event, target, hook_count) -> None"""

type OnResolved = Callable[[str, str, str, str, int], None]
"""(event, target, action, reason, duration_ms) -> None"""

type OnWireHookRequest = Callable[[WireHookHandle], Awaitable[None]]
"""Called when a wire hook needs client handling. The callback should send
the request over the wire and resolve the handle when the client responds."""


@dataclass
class WireHookSubscription:
    """A client-side hook subscription registered via wire initialize."""

    id: str
    event: str
    matcher: str = ""
    timeout: int = 30


@dataclass
class WireHookHandle:
    """A pending wire hook request waiting for client response."""

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    subscription_id: str = ""
    event: str = ""
    target: str = ""
    input_data: dict[str, Any] = field(default_factory=lambda: {})
    _future: asyncio.Future[HookResult] | None = field(default=None, repr=False)

    def _get_future(self) -> asyncio.Future[HookResult]:
        if self._future is None:
            self._future = asyncio.get_event_loop().create_future()
        return self._future

    async def wait(self) -> HookResult:
        """Wait for the client to respond."""
        return await self._get_future()

    def resolve(self, action: str = "allow", reason: str = "") -> None:
        """Resolve with client's decision."""
        result = HookResult(action=action, reason=reason)  # type: ignore[arg-type]
        future = self._get_future()
        if not future.done():
            future.set_result(result)


class HookEngine:
    """Loads hook definitions and executes matching hooks in parallel.

    Supports two hook sources:
    - Server-side (config.toml): shell commands executed locally
    - Client-side (wire subscriptions): forwarded to client via HookRequest
    """

    def __init__(
        self,
        hooks: list[HookDef] | None = None,
        cwd: str | None = None,
        *,
        on_triggered: OnTriggered | None = None,
        on_resolved: OnResolved | None = None,
        on_wire_hook: OnWireHookRequest | None = None,
    ):
        self._hooks: list[HookDef] = list(hooks) if hooks else []
        self._wire_subs: list[WireHookSubscription] = []
        self._cwd = cwd
        self._on_triggered = on_triggered
        self._on_resolved = on_resolved
        self._on_wire_hook = on_wire_hook
        self._by_event: dict[str, list[HookDef]] = {}
        self._wire_by_event: dict[str, list[WireHookSubscription]] = {}
        self._rebuild_index()

    def _rebuild_index(self) -> None:
        self._by_event.clear()
        for h in self._hooks:
            self._by_event.setdefault(h.event, []).append(h)
        self._wire_by_event.clear()
        for s in self._wire_subs:
            self._wire_by_event.setdefault(s.event, []).append(s)

    def add_hooks(self, hooks: list[HookDef]) -> None:
        """Add server-side hooks at runtime. Rebuilds index."""
        self._hooks.extend(hooks)
        self._rebuild_index()

    def add_wire_subscriptions(self, subs: list[WireHookSubscription]) -> None:
        """Register client-side hook subscriptions from wire initialize."""
        self._wire_subs.extend(subs)
        self._rebuild_index()

    def set_callbacks(
        self,
        on_triggered: OnTriggered | None = None,
        on_resolved: OnResolved | None = None,
        on_wire_hook: OnWireHookRequest | None = None,
    ) -> None:
        """Set wire event callbacks."""
        self._on_triggered = on_triggered
        self._on_resolved = on_resolved
        self._on_wire_hook = on_wire_hook

    @property
    def has_hooks(self) -> bool:
        return bool(self._hooks) or bool(self._wire_subs)

    def has_hooks_for(self, event: HookEventType) -> bool:
        return bool(self._by_event.get(event)) or bool(self._wire_by_event.get(event))

    @property
    def summary(self) -> dict[str, int]:
        """Event -> total count of hooks (server + wire)."""
        counts: dict[str, int] = {}
        for event, hooks in self._by_event.items():
            counts[event] = counts.get(event, 0) + len(hooks)
        for event, subs in self._wire_by_event.items():
            counts[event] = counts.get(event, 0) + len(subs)
        return counts

    def details(self) -> dict[str, list[dict[str, str]]]:
        """Event -> list of {matcher, command/type} for display."""
        result: dict[str, list[dict[str, str]]] = {}
        for event, hooks in self._by_event.items():
            entries = result.setdefault(event, [])
            for h in hooks:
                entries.append(
                    {
                        "matcher": h.matcher or "(all)",
                        "source": "server",
                        "command": h.command,
                    }
                )
        for event, subs in self._wire_by_event.items():
            entries = result.setdefault(event, [])
            for s in subs:
                entries.append(
                    {
                        "matcher": s.matcher or "(all)",
                        "source": "wire",
                        "command": "(client-side)",
                    }
                )
        return result

    def _match_regex(self, pattern: str, value: str) -> bool:
        if not pattern:
            return True
        try:
            return bool(re.search(pattern, value))
        except re.error:
            logger.warning("Invalid regex in hook matcher: {}", pattern)
            return False

    async def trigger(
        self,
        event: HookEventType,
        *,
        matcher_value: str = "",
        input_data: dict[str, Any],
    ) -> list[HookResult]:
        """Run all matching hooks (server + wire) in parallel."""

        # --- Match server-side hooks ---
        seen_commands: set[str] = set()
        server_matched: list[HookDef] = []
        for h in self._by_event.get(event, []):
            if not self._match_regex(h.matcher, matcher_value):
                continue
            if h.command in seen_commands:
                continue
            seen_commands.add(h.command)
            server_matched.append(h)

        # --- Match wire subscriptions ---
        wire_matched: list[WireHookSubscription] = []
        for s in self._wire_by_event.get(event, []):
            if not self._match_regex(s.matcher, matcher_value):
                continue
            wire_matched.append(s)

        total = len(server_matched) + len(wire_matched)
        if total == 0:
            return []

        logger.debug(
            "Triggering {} hooks for {} ({} server, {} wire)",
            total,
            event,
            len(server_matched),
            len(wire_matched),
        )

        # --- HookTriggered ---
        if self._on_triggered:
            self._on_triggered(event, matcher_value, total)

        t0 = time.monotonic()
        tasks: list[asyncio.Task[HookResult]] = []

        # Server-side: run shell commands
        for h in server_matched:
            tasks.append(
                asyncio.create_task(
                    run_hook(h.command, input_data, timeout=h.timeout, cwd=self._cwd)
                )
            )

        # Wire-side: send request to client, wait for response
        for s in wire_matched:
            tasks.append(
                asyncio.create_task(
                    self._dispatch_wire_hook(
                        s.id, event, matcher_value, input_data, timeout=s.timeout
                    )
                )
            )

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

    async def _dispatch_wire_hook(
        self,
        subscription_id: str,
        event: str,
        target: str,
        input_data: dict[str, Any],
        *,
        timeout: int = 30,
    ) -> HookResult:
        """Send a hook request to the wire client and wait for response."""
        if not self._on_wire_hook:
            return HookResult(action="allow")

        handle = WireHookHandle(
            subscription_id=subscription_id,
            event=event,
            target=target,
            input_data=input_data,
        )
        try:
            await self._on_wire_hook(handle)
            return await asyncio.wait_for(handle.wait(), timeout=timeout)
        except TimeoutError:
            logger.warning("Wire hook timed out: {} {}", event, target)
            return HookResult(action="allow", timed_out=True)
        except Exception as e:
            logger.warning("Wire hook failed: {} {}: {}", event, target, e)
            return HookResult(action="allow")

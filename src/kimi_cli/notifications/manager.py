from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path

from kimi_cli.config import NotificationConfig
from kimi_cli.utils.logging import logger

from .models import (
    NotificationDelivery,
    NotificationEvent,
    NotificationSinkState,
    NotificationView,
)
from .store import NotificationStore


class NotificationManager:
    def __init__(self, root: Path, config: NotificationConfig) -> None:
        self._config = config
        self._store = NotificationStore(root)

    @property
    def store(self) -> NotificationStore:
        return self._store

    def new_id(self) -> str:
        return f"n{uuid.uuid4().hex[:8]}"

    def _initial_delivery(self, event: NotificationEvent) -> NotificationDelivery:
        return NotificationDelivery(sinks={sink: NotificationSinkState() for sink in event.targets})

    def find_by_dedupe_key(self, dedupe_key: str) -> NotificationView | None:
        for view in self._store.list_views():
            if view.event.dedupe_key == dedupe_key:
                return view
        return None

    def publish(self, event: NotificationEvent) -> NotificationView:
        if event.dedupe_key:
            existing = self.find_by_dedupe_key(event.dedupe_key)
            if existing is not None:
                return existing
        delivery = self._initial_delivery(event)
        self._store.create_notification(event, delivery)
        return NotificationView(event=event, delivery=delivery)

    def recover(self) -> None:
        now = time.time()
        stale_after = self._config.claim_stale_after_ms / 1000
        for view in self._store.list_views():
            updated = False
            delivery = view.delivery.model_copy(deep=True)
            for sink_state in delivery.sinks.values():
                if sink_state.status != "claimed" or sink_state.claimed_at is None:
                    continue
                if now - sink_state.claimed_at <= stale_after:
                    continue
                sink_state.status = "pending"
                sink_state.claimed_at = None
                updated = True
            if updated:
                self._store.write_delivery(view.event.id, delivery)

    def has_pending_for_sink(self, sink: str) -> bool:
        """Check whether any notification has a pending delivery for *sink*."""
        for view in self._store.list_views():
            sink_state = view.delivery.sinks.get(sink)
            if sink_state is not None and sink_state.status == "pending":
                return True
        return False

    def claim_for_sink(self, sink: str, *, limit: int = 8) -> list[NotificationView]:
        self.recover()
        claimed: list[NotificationView] = []
        now = time.time()
        for view in reversed(self._store.list_views()):
            sink_state = view.delivery.sinks.get(sink)
            if sink_state is None or sink_state.status == "acked":
                continue
            if sink_state.status == "claimed":
                continue
            delivery = view.delivery.model_copy(deep=True)
            target_state = delivery.sinks[sink]
            target_state.status = "claimed"
            target_state.claimed_at = now
            self._store.write_delivery(view.event.id, delivery)
            claimed.append(NotificationView(event=view.event, delivery=delivery))
            if len(claimed) >= limit:
                break
        return claimed

    async def deliver_pending(
        self,
        sink: str,
        *,
        on_notification: Callable[[NotificationView], Awaitable[None] | None],
        limit: int = 8,
        before_claim: Callable[[], object] | None = None,
    ) -> list[NotificationView]:
        """Deliver pending notifications for one sink using a shared claim/ack flow.

        If the handler raises for a notification, the error is logged and that
        notification stays in ``claimed`` state (will be recovered later).
        Delivery continues for remaining notifications.
        """
        if before_claim is not None:
            before_claim()

        delivered: list[NotificationView] = []
        for view in self.claim_for_sink(sink, limit=limit):
            try:
                result = on_notification(view)
                if result is not None:
                    await result
            except Exception:
                logger.exception(
                    "Notification handler failed for {sink}/{id}, leaving claimed for recovery",
                    sink=sink,
                    id=view.event.id,
                )
                continue
            delivered.append(self.ack(sink, view.event.id))
        return delivered

    def ack(self, sink: str, notification_id: str) -> NotificationView:
        view = self._store.merged_view(notification_id)
        delivery = view.delivery.model_copy(deep=True)
        sink_state = delivery.sinks.get(sink)
        if sink_state is None:
            return view
        sink_state.status = "acked"
        sink_state.acked_at = time.time()
        sink_state.claimed_at = None
        self._store.write_delivery(notification_id, delivery)
        return NotificationView(event=view.event, delivery=delivery)

    def ack_ids(self, sink: str, notification_ids: set[str]) -> None:
        for notification_id in notification_ids:
            try:
                self.ack(sink, notification_id)
            except (FileNotFoundError, ValueError):
                continue

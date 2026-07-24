from __future__ import annotations

import re
from pathlib import Path

from pydantic import ValidationError

from kimi_cli.utils.io import atomic_json_write
from kimi_cli.utils.logging import logger

from .models import NotificationDelivery, NotificationEvent, NotificationView

_VALID_NOTIFICATION_ID = re.compile(r"^[a-z0-9]{2,20}$")


def _validate_notification_id(notification_id: str) -> None:
    if not _VALID_NOTIFICATION_ID.match(notification_id):
        raise ValueError(f"Invalid notification_id: {notification_id!r}")


class NotificationStore:
    EVENT_FILE = "event.json"
    DELIVERY_FILE = "delivery.json"

    def __init__(self, root: Path):
        self._root = root

    @property
    def root(self) -> Path:
        return self._root

    def _ensure_root(self) -> Path:
        """Return the root directory, creating it if it does not exist."""
        self._root.mkdir(parents=True, exist_ok=True)
        return self._root

    def notification_dir(self, notification_id: str) -> Path:
        _validate_notification_id(notification_id)
        path = self._ensure_root() / notification_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def notification_path(self, notification_id: str) -> Path:
        _validate_notification_id(notification_id)
        return self.root / notification_id

    def event_path(self, notification_id: str) -> Path:
        return self.notification_path(notification_id) / self.EVENT_FILE

    def delivery_path(self, notification_id: str) -> Path:
        return self.notification_path(notification_id) / self.DELIVERY_FILE

    def create_notification(
        self,
        event: NotificationEvent,
        delivery: NotificationDelivery,
    ) -> None:
        notification_dir = self.notification_dir(event.id)
        atomic_json_write(event.model_dump(mode="json"), notification_dir / self.EVENT_FILE)
        atomic_json_write(delivery.model_dump(mode="json"), notification_dir / self.DELIVERY_FILE)

    def list_notification_ids(self) -> list[str]:
        if not self.root.exists():
            return []
        notification_ids: list[str] = []
        for path in sorted(self.root.iterdir()):
            if not path.is_dir():
                continue
            if not (path / self.EVENT_FILE).exists():
                continue
            notification_ids.append(path.name)
        return notification_ids

    def read_event(self, notification_id: str) -> NotificationEvent:
        return NotificationEvent.model_validate_json(
            self.event_path(notification_id).read_text(encoding="utf-8")
        )

    def write_event(self, event: NotificationEvent) -> None:
        atomic_json_write(event.model_dump(mode="json"), self.event_path(event.id))

    def read_delivery(self, notification_id: str) -> NotificationDelivery:
        path = self.delivery_path(notification_id)
        if not path.exists():
            return NotificationDelivery()
        try:
            return NotificationDelivery.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValidationError, ValueError, UnicodeDecodeError) as exc:
            logger.warning(
                "Failed to read notification delivery {path}; using defaults: {error}",
                path=path,
                error=exc,
            )
            return NotificationDelivery()

    def write_delivery(self, notification_id: str, delivery: NotificationDelivery) -> None:
        atomic_json_write(delivery.model_dump(mode="json"), self.delivery_path(notification_id))

    def merged_view(self, notification_id: str) -> NotificationView:
        return NotificationView(
            event=self.read_event(notification_id),
            delivery=self.read_delivery(notification_id),
        )

    def list_views(self) -> list[NotificationView]:
        views: list[NotificationView] = []
        for notification_id in self.list_notification_ids():
            try:
                views.append(self.merged_view(notification_id))
            except (OSError, ValidationError, ValueError, UnicodeDecodeError) as exc:
                logger.warning(
                    "Skipping invalid notification {notification_id} from {path}: {error}",
                    notification_id=notification_id,
                    path=self.root / notification_id / self.EVENT_FILE,
                    error=exc,
                )
        views.sort(key=lambda view: view.event.created_at, reverse=True)
        return views

import asyncio
from collections.abc import Awaitable, Callable

from kimi_cli.utils.logging import logger

from .manager import NotificationManager
from .models import NotificationSink, NotificationView


class NotificationWatcher:
    def __init__(
        self,
        manager: NotificationManager,
        *,
        sink: NotificationSink,
        on_notification: Callable[[NotificationView], Awaitable[None] | None],
        before_poll: Callable[[], object] | None = None,
        interval_s: float = 1.0,
    ) -> None:
        self._manager = manager
        self._sink = sink
        self._on_notification = on_notification
        self._before_poll = before_poll
        self._interval_s = interval_s

    async def poll_once(self) -> list[NotificationView]:
        return await self._manager.deliver_pending(
            self._sink,
            on_notification=self._on_notification,
            before_claim=self._before_poll,
        )

    async def run_forever(self) -> None:
        while True:
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("NotificationWatcher poll failed")
            await asyncio.sleep(self._interval_s)

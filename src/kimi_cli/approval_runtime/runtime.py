from __future__ import annotations

import asyncio
import uuid
from contextvars import ContextVar, Token
from typing import TYPE_CHECKING

from kimi_cli.utils.logging import logger
from kimi_cli.wire.types import ApprovalRequest, ApprovalResponse

from .models import (
    ApprovalRequestRecord,
    ApprovalResponseKind,
    ApprovalRuntimeEvent,
    ApprovalSource,
    ApprovalSourceKind,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from kimi_cli.wire.root_hub import RootWireHub
    from kimi_cli.wire.types import DisplayBlock


class ApprovalCancelledError(Exception):
    """Raised when a pending approval is cancelled by its source lifecycle."""


_current_approval_source = ContextVar[ApprovalSource | None](
    "current_approval_source",
    default=None,
)


def get_current_approval_source_or_none() -> ApprovalSource | None:
    return _current_approval_source.get()


def set_current_approval_source(source: ApprovalSource) -> Token[ApprovalSource | None]:
    return _current_approval_source.set(source)


def reset_current_approval_source(token: Token[ApprovalSource | None]) -> None:
    _current_approval_source.reset(token)


class ApprovalRuntime:
    def __init__(self) -> None:
        self._requests: dict[str, ApprovalRequestRecord] = {}
        self._waiters: dict[str, asyncio.Future[tuple[ApprovalResponseKind, str]]] = {}
        self._subscribers: dict[str, Callable[[ApprovalRuntimeEvent], None]] = {}
        self._root_wire_hub: RootWireHub | None = None

    def bind_root_wire_hub(self, root_wire_hub: RootWireHub) -> None:
        if self._root_wire_hub is root_wire_hub:
            return
        self._root_wire_hub = root_wire_hub

    def create_request(
        self,
        *,
        sender: str,
        action: str,
        description: str,
        tool_call_id: str,
        display: list[DisplayBlock],
        source: ApprovalSource,
        request_id: str | None = None,
    ) -> ApprovalRequestRecord:
        request = ApprovalRequestRecord(
            id=request_id or str(uuid.uuid4()),
            tool_call_id=tool_call_id,
            sender=sender,
            action=action,
            description=description,
            display=display,
            source=source,
        )
        self._requests[request.id] = request
        self._publish_event(ApprovalRuntimeEvent(kind="request_created", request=request))
        self._publish_wire_request(request)
        return request

    async def wait_for_response(
        self, request_id: str, timeout: float | None = None
    ) -> tuple[ApprovalResponseKind, str]:
        waiter = self._waiters.get(request_id)
        request = self._requests.get(request_id)
        if request is None:
            raise KeyError(f"Approval request not found: {request_id}")
        if waiter is None:
            if request.status == "cancelled":
                raise ApprovalCancelledError(request_id)
            if request.status == "resolved":
                assert request.response is not None
                return request.response, request.feedback
            waiter = asyncio.get_running_loop().create_future()
            self._waiters[request_id] = waiter
        try:
            if timeout is None:
                return await asyncio.shield(waiter)
            return await asyncio.wait_for(asyncio.shield(waiter), timeout=timeout)
        except asyncio.CancelledError:
            if self._waiters.get(request_id) is waiter:
                self._waiters.pop(request_id, None)
            raise
        except TimeoutError:
            logger.warning(
                "Approval request {id} timed out after {t}s",
                id=request_id,
                t=timeout,
            )
            # Pop the waiter before cancelling so _cancel_request won't
            # set_exception on a future that nobody is awaiting (which would
            # trigger an "exception was never retrieved" warning from asyncio).
            self._waiters.pop(request_id, None)
            self._cancel_request(request_id, feedback="approval timed out")
            raise ApprovalCancelledError(request_id) from None

    def resolve(self, request_id: str, response: ApprovalResponseKind, feedback: str = "") -> bool:
        request = self._requests.get(request_id)
        if request is None or request.status != "pending":
            return False
        request.status = "resolved"
        request.response = response
        request.feedback = feedback
        import time

        request.resolved_at = time.time()
        waiter = self._waiters.pop(request_id, None)
        if waiter is not None and not waiter.done():
            waiter.set_result((response, feedback))
        self._publish_event(ApprovalRuntimeEvent(kind="request_resolved", request=request))
        self._publish_wire_response(request_id, response, feedback)
        return True

    def _cancel_request(self, request_id: str, feedback: str = "") -> None:
        """Cancel a single pending request by ID."""
        import time

        request = self._requests.get(request_id)
        if request is None or request.status != "pending":
            return
        request.status = "cancelled"
        request.response = "reject"
        request.feedback = feedback
        request.resolved_at = time.time()
        waiter = self._waiters.pop(request_id, None)
        if waiter is not None and not waiter.done():
            waiter.set_exception(ApprovalCancelledError(request_id))
        self._publish_event(ApprovalRuntimeEvent(kind="request_resolved", request=request))
        self._publish_wire_response(request_id, "reject", feedback)

    def cancel_by_source(self, source_kind: ApprovalSourceKind, source_id: str) -> int:
        cancelled = 0
        import time

        for request_id, request in self._requests.items():
            if request.status != "pending":
                continue
            if request.source.kind != source_kind or request.source.id != source_id:
                continue
            request.status = "cancelled"
            request.response = "reject"
            request.resolved_at = time.time()
            waiter = self._waiters.pop(request_id, None)
            if waiter is not None and not waiter.done():
                waiter.set_exception(ApprovalCancelledError(request_id))
            self._publish_event(ApprovalRuntimeEvent(kind="request_resolved", request=request))
            self._publish_wire_response(request_id, "reject")
            cancelled += 1
        return cancelled

    def list_pending(self) -> list[ApprovalRequestRecord]:
        pending = [request for request in self._requests.values() if request.status == "pending"]
        pending.sort(key=lambda request: request.created_at)
        return pending

    def get_request(self, request_id: str) -> ApprovalRequestRecord | None:
        return self._requests.get(request_id)

    def subscribe(self, callback: Callable[[ApprovalRuntimeEvent], None]) -> str:
        token = uuid.uuid4().hex
        self._subscribers[token] = callback
        return token

    def unsubscribe(self, token: str) -> None:
        self._subscribers.pop(token, None)

    def _publish_event(self, event: ApprovalRuntimeEvent) -> None:
        for callback in list(self._subscribers.values()):
            try:
                callback(event)
            except Exception:
                logger.exception("Approval runtime event subscriber failed")

    def _publish_wire_request(self, request: ApprovalRequestRecord) -> None:
        if self._root_wire_hub is None:
            return
        self._root_wire_hub.publish_nowait(
            ApprovalRequest(
                id=request.id,
                tool_call_id=request.tool_call_id,
                sender=request.sender,
                action=request.action,
                description=request.description,
                display=request.display,
                source_kind=request.source.kind,
                source_id=request.source.id,
                agent_id=request.source.agent_id,
                subagent_type=request.source.subagent_type,
            )
        )

    def _publish_wire_response(
        self, request_id: str, response: ApprovalResponseKind, feedback: str = ""
    ) -> None:
        if self._root_wire_hub is None:
            return
        self._root_wire_hub.publish_nowait(
            ApprovalResponse(
                request_id=request_id,
                response=response,
                feedback=feedback,
            )
        )

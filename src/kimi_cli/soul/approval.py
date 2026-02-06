from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.utils.aioqueue import Queue
from kimi_cli.utils.logging import logger
from kimi_cli.wire.types import DisplayBlock


@dataclass(frozen=True, slots=True, kw_only=True)
class Request:
    id: str
    tool_call_id: str
    sender: str
    action: str
    description: str
    display: list[DisplayBlock]


type Response = Literal["approve", "approve_for_session", "reject"]


class ApprovalState:
    def __init__(self, yolo: bool = False, *, state_file: Path | None = None):
        self.yolo = yolo
        self.auto_approve_actions: set[str] = set()
        """Set of action names that should automatically be approved."""
        self._state_file = state_file
        if self._state_file is not None:
            self._load()

    def _load(self) -> None:
        try:
            if not self._state_file.exists():
                return
            data = json.loads(self._state_file.read_text(encoding="utf-8"))
            actions = data.get("auto_approve_actions", [])
            if not isinstance(actions, list):
                logger.warning(
                    "Invalid approval state file format: {file}", file=self._state_file
                )
                return
            self.auto_approve_actions = {action for action in actions if isinstance(action, str)}
        except Exception:
            logger.exception(
                "Failed to load approval state file: {file}", file=self._state_file
            )

    def _persist(self) -> None:
        if self._state_file is None:
            return
        try:
            self._state_file.parent.mkdir(parents=True, exist_ok=True)
            payload = {"auto_approve_actions": sorted(self.auto_approve_actions)}
            self._state_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except Exception:
            logger.exception(
                "Failed to persist approval state file: {file}", file=self._state_file
            )

    def add_auto_approve_action(self, action: str) -> None:
        if action in self.auto_approve_actions:
            return
        self.auto_approve_actions.add(action)
        self._persist()


class Approval:
    def __init__(
        self,
        yolo: bool = False,
        *,
        state: ApprovalState | None = None,
        state_file: Path | None = None,
    ):
        self._request_queue = Queue[Request]()
        self._requests: dict[str, tuple[Request, asyncio.Future[bool]]] = {}
        self._state = state or ApprovalState(yolo=yolo, state_file=state_file)

    def share(self) -> Approval:
        """Create a new approval queue that shares state (yolo + auto-approve)."""
        return Approval(state=self._state)

    def set_yolo(self, yolo: bool) -> None:
        self._state.yolo = yolo

    def is_yolo(self) -> bool:
        return self._state.yolo

    async def request(
        self,
        sender: str,
        action: str,
        description: str,
        display: list[DisplayBlock] | None = None,
    ) -> bool:
        """
        Request approval for the given action. Intended to be called by tools.

        Args:
            sender (str): The name of the sender.
            action (str): The action to request approval for.
                This is used to identify the action for auto-approval.
            description (str): The description of the action. This is used to display to the user.

        Returns:
            bool: True if the action is approved, False otherwise.

        Raises:
            RuntimeError: If the approval is requested from outside a tool call.
        """
        tool_call = get_current_tool_call_or_none()
        if tool_call is None:
            raise RuntimeError("Approval must be requested from a tool call.")

        logger.debug(
            "{tool_name} ({tool_call_id}) requesting approval: {action} {description}",
            tool_name=tool_call.function.name,
            tool_call_id=tool_call.id,
            action=action,
            description=description,
        )
        if self._state.yolo:
            return True

        if action in self._state.auto_approve_actions:
            return True

        request = Request(
            id=str(uuid.uuid4()),
            tool_call_id=tool_call.id,
            sender=sender,
            action=action,
            description=description,
            display=display or [],
        )
        approved_future = asyncio.Future[bool]()
        self._request_queue.put_nowait(request)
        self._requests[request.id] = (request, approved_future)
        return await approved_future

    async def fetch_request(self) -> Request:
        """
        Fetch an approval request from the queue. Intended to be called by the soul.
        """
        while True:
            request = await self._request_queue.get()
            if request.action in self._state.auto_approve_actions:
                # the action is not auto-approved when the request was created, but now it should be
                logger.debug(
                    "Auto-approving previously requested action: {action}", action=request.action
                )
                self.resolve_request(request.id, "approve")
                continue

            return request

    def resolve_request(self, request_id: str, response: Response) -> None:
        """
        Resolve an approval request with the given response. Intended to be called by the soul.

        Args:
            request_id (str): The ID of the request to resolve.
            response (Response): The response to the request.

        Raises:
            KeyError: If there is no pending request with the given ID.
        """
        request_tuple = self._requests.pop(request_id, None)
        if request_tuple is None:
            raise KeyError(f"No pending request with ID {request_id}")
        request, future = request_tuple

        logger.debug(
            "Received approval response for request {request_id}: {response}",
            request_id=request_id,
            response=response,
        )
        match response:
            case "approve":
                future.set_result(True)
            case "approve_for_session":
                self._state.add_auto_approve_action(request.action)
                future.set_result(True)
            case "reject":
                future.set_result(False)

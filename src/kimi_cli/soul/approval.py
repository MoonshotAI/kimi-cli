import asyncio

from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.utils.logging import logger
from kimi_cli.wire.message import ApprovalRequest, ApprovalResponse


class Approval:
    def __init__(self, yolo: bool = False):
        self._request_queue = asyncio.Queue[ApprovalRequest]()
        self._yolo = yolo
        self._auto_approve_actions: set[str] = set()  # TODO: persist across sessions
        """Set of action names that should automatically be approved."""

    def set_yolo(self, yolo: bool) -> None:
        self._yolo = yolo

    async def request(self, sender: str, action: str, description: str) -> bool:
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
        if self._yolo:
            return True

        if action in self._auto_approve_actions:
            return True

        request = ApprovalRequest(tool_call.id, sender, action, description)
        self._request_queue.put_nowait(request)
        response = await request.wait()
        logger.debug("Received approval response: {response}", response=response)
        match response:
            case ApprovalResponse.APPROVE:
                return True
            case ApprovalResponse.APPROVE_FOR_SESSION:
                self._auto_approve_actions.add(action)
                return True
            case ApprovalResponse.REJECT:
                return False

    async def fetch_request(self) -> ApprovalRequest:
        """
        Fetch an approval request from the queue. Intended to be called by the soul.
        """
        return await self._request_queue.get()

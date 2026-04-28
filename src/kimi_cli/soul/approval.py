from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import TYPE_CHECKING, Literal

from kimi_cli.approval_runtime import (
    ApprovalCancelledError,
    ApprovalRuntime,
    ApprovalSource,
    get_current_approval_source_or_none,
)
from kimi_cli.soul.toolset import get_current_tool_call_or_none
from kimi_cli.tools.utils import ToolRejectedError
from kimi_cli.utils.logging import logger
from kimi_cli.wire.types import DisplayBlock

if TYPE_CHECKING:
    from kimi_cli.hooks.engine import HookEngine

type Response = Literal["approve", "approve_for_session", "reject"]


class ApprovalResult:
    """Result of an approval request. Behaves as bool for backward compatibility."""

    __slots__ = ("approved", "feedback")

    def __init__(self, approved: bool, feedback: str = ""):
        self.approved = approved
        self.feedback = feedback

    def __bool__(self) -> bool:
        return self.approved

    def rejection_error(self) -> ToolRejectedError:
        if self.feedback:
            return ToolRejectedError(
                message=(f"The tool call is rejected by the user. User feedback: {self.feedback}"),
                brief=f"Rejected: {self.feedback}",
                has_feedback=True,
            )
        source = get_current_approval_source_or_none()
        is_subagent = source is not None and source.agent_id is not None
        if is_subagent:
            return ToolRejectedError(
                message=(
                    "The tool call is rejected by the user. "
                    "Try a different approach to complete your task, or explain the "
                    "limitation in your summary if no alternative is available. "
                    "Do not retry the same tool call, and do not attempt to bypass "
                    "this restriction through indirect means."
                ),
            )
        return ToolRejectedError()


class ApprovalState:
    def __init__(
        self,
        yolo: bool = False,
        auto_approve_actions: set[str] | None = None,
        on_change: Callable[[], None] | None = None,
    ):
        self.yolo = yolo
        self.auto_approve_actions: set[str] = auto_approve_actions or set()
        """Set of action names that should automatically be approved."""
        self._on_change = on_change

    def notify_change(self) -> None:
        if self._on_change is not None:
            self._on_change()


class Approval:
    def __init__(
        self,
        yolo: bool = False,
        *,
        state: ApprovalState | None = None,
        runtime: ApprovalRuntime | None = None,
        hook_engine: HookEngine | None = None,
    ):
        self._state = state or ApprovalState(yolo=yolo)
        self._runtime = runtime or ApprovalRuntime()
        self._hook_engine = hook_engine

    def share(self) -> Approval:
        """Create a new approval queue that shares state (yolo + auto-approve)."""
        return Approval(state=self._state, runtime=self._runtime, hook_engine=self._hook_engine)

    def set_runtime(self, runtime: ApprovalRuntime) -> None:
        self._runtime = runtime

    def set_hook_engine(self, hook_engine: HookEngine) -> None:
        self._hook_engine = hook_engine

    @property
    def runtime(self) -> ApprovalRuntime:
        return self._runtime

    def set_yolo(self, yolo: bool) -> None:
        self._state.yolo = yolo
        self._state.notify_change()

    def is_yolo(self) -> bool:
        return self._state.yolo

    async def request(
        self,
        sender: str,
        action: str,
        description: str,
        display: list[DisplayBlock] | None = None,
    ) -> ApprovalResult:
        """
        Request approval for the given action. Intended to be called by tools.

        Args:
            sender (str): The name of the sender.
            action (str): The action to request approval for.
                This is used to identify the action for auto-approval.
            description (str): The description of the action. This is used to display to the user.

        Returns:
            ApprovalResult: Result with ``approved`` flag and optional ``feedback``.
                Behaves as ``bool`` via ``__bool__``, so ``if not result:`` works.

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
            from kimi_cli.telemetry import track

            track(
                "tool_approved",
                tool_name=tool_call.function.name,
                approval_mode="yolo",
            )
            return ApprovalResult(approved=True)

        if action in self._state.auto_approve_actions:
            from kimi_cli.telemetry import track

            track(
                "tool_approved",
                tool_name=tool_call.function.name,
                approval_mode="auto_session",
            )
            return ApprovalResult(approved=True)

        # --- PermissionRequest hook ---
        if self._hook_engine is not None:
            from pathlib import Path

            from kimi_cli.hooks import events
            from kimi_cli.soul.toolset import _get_session_id

            # Build tool_input from action and description
            tool_input: dict = {"action": action, "description": description}

            hook_results = await self._hook_engine.trigger(
                "PermissionRequest",
                matcher_value=tool_call.function.name,
                input_data=events.permission_request(
                    session_id=_get_session_id(),  # Use actual CLI session id
                    cwd=str(Path.cwd()),
                    tool_name=tool_call.function.name,
                    tool_input=tool_input,
                    tool_call_id=tool_call.id,
                    action=action,
                    description=description,
                ),
            )

            # Aggregate results: block takes priority, then allow, then ask
            # Timeouts/errors result in "ask" (fall back to terminal approval)
            has_explicit_allow = False
            allow_reason = ""
            has_block = False
            block_reason = ""

            for result in hook_results:
                if result.action == "block":
                    # Block takes highest priority - check action, not reason
                    has_block = True
                    block_reason = result.reason
                    break
                elif result.action == "allow" and not result.timed_out and result.exit_code == 0:
                    # Allow only if:
                    # - no block found
                    # - not timed out (timed-out hooks return action="allow")
                    # - exit_code is 0 (errors/crashes return action="allow" with non-zero exit)
                    has_explicit_allow = True
                    allow_reason = result.reason
                # result.action == "ask" or timeout/error/crash: continue to check other results

            if has_block:
                logger.debug(
                    "PermissionRequest hook denied {tool_name}: {reason}",
                    tool_name=tool_call.function.name,
                    reason=block_reason,
                )
                return ApprovalResult(
                    approved=False,
                    feedback=block_reason or "Denied by PermissionRequest hook",
                )
            elif has_explicit_allow:
                logger.debug(
                    "PermissionRequest hook allowed {tool_name}",
                    tool_name=tool_call.function.name,
                )
                return ApprovalResult(approved=True)
            # If no explicit decision or only "ask"/timeouts, continue to terminal approval

        request_id = str(uuid.uuid4())
        display_blocks = display or []
        source = get_current_approval_source_or_none() or ApprovalSource(
            kind="foreground_turn",
            id=tool_call.id,
        )
        self._runtime.create_request(
            request_id=request_id,
            tool_call_id=tool_call.id,
            sender=sender,
            action=action,
            description=description,
            display=display_blocks,
            source=source,
        )
        try:
            response, feedback = await self._runtime.wait_for_response(request_id)
        except ApprovalCancelledError:
            from kimi_cli.telemetry import track

            track(
                "tool_rejected",
                tool_name=tool_call.function.name,
                approval_mode="cancelled",
            )
            record = self._runtime.get_request(request_id)
            return ApprovalResult(approved=False, feedback=record.feedback if record else "")
        from kimi_cli.telemetry import track

        match response:
            case "approve":
                track(
                    "tool_approved",
                    tool_name=tool_call.function.name,
                    approval_mode="manual",
                )
                return ApprovalResult(approved=True)
            case "approve_for_session":
                track(
                    "tool_approved",
                    tool_name=tool_call.function.name,
                    approval_mode="manual",
                )
                self._state.auto_approve_actions.add(action)
                self._state.notify_change()
                for pending in self._runtime.list_pending():
                    if pending.action == action:
                        self._runtime.resolve(pending.id, "approve")
                return ApprovalResult(approved=True)
            case "reject":
                track(
                    "tool_rejected",
                    tool_name=tool_call.function.name,
                    approval_mode="manual",
                )
                return ApprovalResult(approved=False, feedback=feedback)
            case _:
                track(
                    "tool_rejected",
                    tool_name=tool_call.function.name,
                    approval_mode="manual",
                )
                return ApprovalResult(approved=False)

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Literal

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

type Response = Literal["approve", "approve_for_session", "reject"]

# Actions that touch files but do not execute arbitrary shell commands.
# Action strings passed by WriteFile and StrReplaceFile tools.
_FILE_ACTIONS = frozenset({
    "edit file",
    "edit file outside of working directory",
})

type ApprovalMode = Literal["manual", "edits", "auto"]


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
        afk: bool = False,
        runtime_afk: bool = False,
        auto_approve_actions: set[str] | None = None,
        approval_mode: ApprovalMode = "manual",
        on_change: Callable[[], None] | None = None,
    ):
        # Derive approval_mode from legacy flags if not explicitly provided.
        if approval_mode == "manual" and (yolo or afk):
            approval_mode = "auto"
        elif approval_mode == "manual" and auto_approve_actions:
            approval_mode = "edits"

        self.approval_mode: ApprovalMode = approval_mode
        """Current approval mode: manual, edits, or auto."""
        # Keep legacy fields for backward compat with tests and external code.
        self.yolo = yolo
        self.afk = afk
        self.runtime_afk = runtime_afk
        self.auto_approve_actions: set[str] = auto_approve_actions or set()
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
    ):
        self._state = state or ApprovalState(yolo=yolo)
        self._runtime = runtime or ApprovalRuntime()

    def share(self) -> Approval:
        """Create a new approval queue that shares approval state."""
        return Approval(state=self._state, runtime=self._runtime)

    def set_runtime(self, runtime: ApprovalRuntime) -> None:
        self._runtime = runtime

    @property
    def runtime(self) -> ApprovalRuntime:
        return self._runtime

    def set_yolo(self, yolo: bool) -> None:
        """Legacy setter; maps to approval_mode for backward compat."""
        self._state.yolo = yolo
        if yolo:
            self._state.approval_mode = "auto"
        elif self._state.approval_mode == "auto" and not self._state.afk:
            self._state.approval_mode = "manual"
        self._state.notify_change()

    def set_afk(self, afk: bool) -> None:
        """Toggle persisted afk (away-from-keyboard) mode.

        Turning it off also clears any invocation-only afk overlay so an
        interactive session started with ``--afk`` can return to interactive
        behavior via ``/afk``.
        """
        self._state.afk = afk
        if afk:
            self._state.approval_mode = "auto"
        elif self._state.approval_mode == "auto" and not self._state.yolo:
            self._state.approval_mode = "manual"
        if not afk:
            self._state.runtime_afk = False
        self._state.notify_change()

    def set_runtime_afk(self, afk: bool) -> None:
        """Toggle invocation-only afk mode without persisting it."""
        self._state.runtime_afk = afk

    def set_approval_mode(self, mode: ApprovalMode) -> None:
        self._state.approval_mode = mode
        self._state.yolo = mode == "auto"
        self._state.afk = False
        self._state.auto_approve_actions.clear()
        self._state.notify_change()

    def cycle_approval_mode(self) -> ApprovalMode:
        """Cycle to the next approval mode (manual → edits → auto → manual)."""
        match self._state.approval_mode:
            case "manual":
                new_mode = "edits"
            case "edits":
                new_mode = "auto"
            case "auto":
                new_mode = "manual"
            case _:
                new_mode = "manual"
        self.set_approval_mode(new_mode)
        return new_mode

    def is_auto_approve(self) -> bool:
        """True when tool calls should be auto-approved."""
        return self._state.approval_mode == "auto" or self.is_afk()

    def is_yolo(self) -> bool:
        """True only when the user explicitly opted into yolo."""
        return self._state.yolo

    def is_yolo_flag(self) -> bool:
        """True only when the user explicitly opted into yolo (not via afk)."""
        return self.is_yolo()

    def is_afk(self) -> bool:
        """True when no user is present (away-from-keyboard)."""
        return self._state.afk or self._state.runtime_afk

    def is_afk_flag(self) -> bool:
        """True only when persisted afk mode is active."""
        return self._state.afk

    def is_runtime_afk(self) -> bool:
        """True only when afk came from this invocation."""
        return self._state.runtime_afk

    def get_auto_approve_actions(self) -> set[str]:
        """Return the set of action names that are auto-approved for this session."""
        return set(self._state.auto_approve_actions)

    def get_approval_mode(self) -> ApprovalMode:
        """Return the current approval mode."""
        return self._state.approval_mode

    def _should_auto_approve(self, action: str) -> bool:
        """Determine if an action should be auto-approved based on current mode."""
        if self._state.approval_mode == "auto" or self.is_afk():
            return True
        if self._state.approval_mode == "edits":
            return action in _FILE_ACTIONS
        return False

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

        if self._should_auto_approve(action):
            from kimi_cli.telemetry import track

            track(
                "tool_approved",
                tool_name=tool_call.function.name,
                approval_mode=self._state.approval_mode,
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
                # Promote approval mode based on action type to keep UX simple.
                if action in _FILE_ACTIONS and self._state.approval_mode == "manual":
                    self.set_approval_mode("edits")
                elif self._state.approval_mode in ("manual", "edits"):
                    self.set_approval_mode("auto")
                else:
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

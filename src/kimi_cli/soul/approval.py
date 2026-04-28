from __future__ import annotations

import fnmatch
import re
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


_GLOB_SPECIAL_RE = re.compile(r"[*?\[\]]")


class ApprovalState:
    def __init__(
        self,
        yolo: bool = False,
        afk: bool = False,
        runtime_afk: bool = False,
        auto_approve_actions: set[str] | None = None,
        on_change: Callable[[], None] | None = None,
    ):
        self.yolo = yolo
        self.afk = afk
        """Persisted session flag. True when no user is present.

        Implies auto-approve and is restored with the session.
        """
        self.runtime_afk = runtime_afk
        """Invocation-only afk flag, e.g. ``--afk`` or ``--print``. Not persisted."""
        # Separate exact action names from glob patterns so that fnmatch is
        # only applied to entries that actually contain glob-special characters.
        self._auto_approve_exact: set[str] = set()
        self._auto_approve_patterns: list[str] = []
        for entry in (auto_approve_actions or set()):
            if _GLOB_SPECIAL_RE.search(entry):
                self._auto_approve_patterns.append(entry)
            else:
                self._auto_approve_exact.add(entry)
        self._on_change = on_change

    def is_auto_approved(self, action: str) -> bool:
        """Return True if *action* matches an exact name or a glob pattern."""
        if action in self._auto_approve_exact:
            return True
        return any(fnmatch.fnmatch(action, p) for p in self._auto_approve_patterns)

    def add_auto_approve_action(self, action: str) -> None:
        """Add *action* as an exact auto-approve name (not a glob pattern)."""
        self._auto_approve_exact.add(action)

    @property
    def auto_approve_actions(self) -> set[str]:
        """All auto-approve entries (exact names + glob patterns) for persistence."""
        return self._auto_approve_exact | set(self._auto_approve_patterns)

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
        self._state.yolo = yolo
        self._state.notify_change()

    def set_afk(self, afk: bool) -> None:
        """Toggle persisted afk (away-from-keyboard) mode.

        Turning it off also clears any invocation-only afk overlay so an
        interactive session started with ``--afk`` can return to interactive
        behavior via ``/afk``.
        """
        self._state.afk = afk
        if not afk:
            self._state.runtime_afk = False
        self._state.notify_change()

    def set_runtime_afk(self, afk: bool) -> None:
        """Toggle invocation-only afk mode without persisting it."""
        self._state.runtime_afk = afk

    def is_auto_approve(self) -> bool:
        """True when tool calls should be auto-approved.

        Afk implies auto-approve, so this returns True whenever either the
        explicit yolo flag or afk is set.
        """
        return self._state.yolo or self.is_afk()

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
        if self.is_auto_approve():
            from kimi_cli.telemetry import track

            track(
                "tool_approved",
                tool_name=tool_call.function.name,
                approval_mode="afk" if self.is_afk() else "yolo",
            )
            return ApprovalResult(approved=True)

        if self._state.is_auto_approved(action):
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
                self._state.add_auto_approve_action(action)
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

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from kosong.message import Message

from kimi_cli.soul.dynamic_injection import DynamicInjection, DynamicInjectionProvider

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul

_YOLO_INJECTION_TYPE = "yolo_mode"

_YOLO_PROMPT = (
    "You are running with automatic tool approval enabled.\n"
    "- Tool approval prompts will be auto-approved.\n"
    "- Interactive questions and plan review may still be available.\n"
    "- Do not assume the user is unavailable unless the system explicitly tells you so."
)

_NON_INTERACTIVE_INJECTION_TYPE = "non_interactive_mode"

_NON_INTERACTIVE_PROMPT = (
    "You are running in non-interactive mode. The user cannot answer questions "
    "or provide feedback during execution.\n"
    "- Do NOT call AskUserQuestion. If you need to make a decision, make your "
    "best judgment and proceed.\n"
    "- EnterPlanMode / ExitPlanMode and similar review flows will auto-resolve "
    "without waiting for the user."
)


class YoloModeInjectionProvider(DynamicInjectionProvider):
    """Injects a one-time reminder when yolo mode is active."""

    def __init__(self) -> None:
        self._injected: bool = False

    async def get_injections(
        self,
        history: Sequence[Message],
        soul: KimiSoul,
    ) -> list[DynamicInjection]:
        if not soul.is_yolo:
            return []
        if self._injected:
            return []
        self._injected = True
        return [DynamicInjection(type=_YOLO_INJECTION_TYPE, content=_YOLO_PROMPT)]


class NonInteractiveModeInjectionProvider(DynamicInjectionProvider):
    """Injects a one-time reminder when user feedback is unavailable."""

    def __init__(self) -> None:
        self._injected: bool = False

    async def get_injections(
        self,
        history: Sequence[Message],
        soul: KimiSoul,
    ) -> list[DynamicInjection]:
        if soul.can_request_user_feedback:
            return []
        if self._injected:
            return []
        self._injected = True
        return [
            DynamicInjection(
                type=_NON_INTERACTIVE_INJECTION_TYPE,
                content=_NON_INTERACTIVE_PROMPT,
            )
        ]

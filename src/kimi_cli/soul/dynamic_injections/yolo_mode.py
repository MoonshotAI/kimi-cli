from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from kosong.message import Message

from kimi_cli.soul.dynamic_injection import DynamicInjection, DynamicInjectionProvider

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul

_YOLO_INJECTION_TYPE = "yolo_mode"

_YOLO_PROMPT = (
    "Yolo mode is enabled for operation approvals.\n"
    "- Operation-type approvals are auto-approved.\n"
    "- AskUserQuestion remains available when the connected client supports interactive "
    "questions.\n"
    "- EnterPlanMode/ExitPlanMode remain interactive unless an explicit plan policy "
    "enables auto-approval."
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

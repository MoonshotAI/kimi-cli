from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from kosong.message import Message

from kimi_cli.soul.dynamic_injection import DynamicInjection, DynamicInjectionProvider

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul

_YOLO_INJECTION_TYPE = "yolo_mode"

_YOLO_PROMPT = (
    "Yolo (auto-approve) mode is active. Tool calls that normally require "
    "user approval will be auto-approved by the harness.\n"
    "- You ARE still in an interactive session. The user is present and "
    "CAN answer AskUserQuestion. Yolo only removes approval friction; "
    "it does NOT remove the user.\n"
    "- Use AskUserQuestion sparingly — only when a decision genuinely "
    "changes your next action (missing requirements, ambiguous goals, "
    "choosing between meaningfully different approaches). Do NOT use it "
    "for routine confirmations or progress check-ins.\n"
    "- For trivial decisions, exercise your best judgment and proceed.\n"
    "- EnterPlanMode / ExitPlanMode will be auto-approved as well."
)


class YoloModeInjectionProvider(DynamicInjectionProvider):
    """Injects a one-time reminder when yolo mode is active (and not afk).

    Afk has its own provider with stricter guidance (no AskUserQuestion).
    """

    def __init__(self) -> None:
        self._injected: bool = False

    async def get_injections(
        self,
        history: Sequence[Message],
        soul: KimiSoul,
    ) -> list[DynamicInjection]:
        if not soul.is_yolo:
            return []
        if soul.is_afk:
            return []
        if soul.is_subagent:
            # Subagents have no AskUserQuestion tool and no real terminal user;
            # claiming "the user is present" would be factually wrong.
            return []
        if self._injected:
            return []
        self._injected = True
        return [DynamicInjection(type=_YOLO_INJECTION_TYPE, content=_YOLO_PROMPT)]

    async def on_context_compacted(self) -> None:
        # Compaction wipes history; the reminder may have been summarized away.
        # Clear the one-shot flag so the next step re-injects while yolo is active.
        self._injected = False

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from kosong.message import Message

from kimi_cli.soul.dynamic_injection import DynamicInjection, DynamicInjectionProvider

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul

_AFK_INJECTION_TYPE = "afk_mode"

_AFK_PROMPT = (
    "You are running in afk mode. No user is present to answer "
    "questions or approve actions. All tool calls are auto-approved by "
    "the harness.\n"
    "- Do NOT call AskUserQuestion — it will be auto-dismissed with no "
    "answer, wasting a turn. Make your best judgment and proceed.\n"
    "- You CAN use EnterPlanMode / ExitPlanMode normally. They will be "
    "auto-approved. Planning still helps you think before acting; use "
    "it for non-trivial tasks, then exit and execute.\n"
    "- Finish the user's request end-to-end in this run. Do not defer "
    "decisions to a human."
)


class AfkModeInjectionProvider(DynamicInjectionProvider):
    """Injects a one-time reminder when afk (away-from-keyboard) mode is active."""

    def __init__(self) -> None:
        self._injected: bool = False

    async def get_injections(
        self,
        history: Sequence[Message],
        soul: KimiSoul,
    ) -> list[DynamicInjection]:
        if not soul.is_afk:
            return []
        if soul.is_subagent:
            # Subagents have no AskUserQuestion tool; repeating the rule
            # just burns tokens on every subagent turn.
            return []
        if self._injected:
            return []
        self._injected = True
        return [DynamicInjection(type=_AFK_INJECTION_TYPE, content=_AFK_PROMPT)]

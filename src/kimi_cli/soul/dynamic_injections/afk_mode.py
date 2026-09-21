from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from kosong.message import Message

from kimi_cli.soul.dynamic_injection import DynamicInjection, DynamicInjectionProvider

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul

# 本模块在 afk（away-from-keyboard，用户离开键盘）模式下注入提醒，
# 告知 agent 当前无人应答、所有工具调用会被自动批准、不得调用 AskUserQuestion。

_AFK_INJECTION_TYPE = "afk_mode"

# 进入 afk 模式时注入的完整引导提示词。
_AFK_PROMPT_ROOT = (
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

# 退出 afk 模式时追加到上下文的提醒。
AFK_DISABLED_REMINDER = (
    "Afk mode is now disabled. The user is back at the terminal and CAN answer "
    "AskUserQuestion.\n"
    "- Ignore any earlier afk mode reminders that said no user is present or "
    "that you must not call AskUserQuestion.\n"
    "- AskUserQuestion is available again when a decision genuinely changes "
    "your next action. Do not ask routine confirmations or progress check-ins.\n"
    "- Tool calls are no longer auto-approved by afk. They may still be "
    "auto-approved if yolo mode remains active."
)


# 仅在 afk 模式下注入一次 afk 引导的 Provider。
class AfkModeInjectionProvider(DynamicInjectionProvider):
    """Injects afk (away-from-keyboard) guidance when no user is present."""

    def __init__(self) -> None:
        self._injected: bool = False

    # 判断是否处于 afk 模式（且非子 agent），满足条件则注入一次。
    async def get_injections(
        self,
        history: Sequence[Message],
        soul: KimiSoul,
    ) -> list[DynamicInjection]:
        _ = history
        if not soul.is_afk:
            return []
        if not soul.is_afk_flag:
            return []

        if soul.is_subagent:
            return []

        if self._injected:
            return []
        self._injected = True
        return [DynamicInjection(type=_AFK_INJECTION_TYPE, content=_AFK_PROMPT_ROOT)]

    # 上下文压缩后重置，允许下一步重新注入 afk 约束。
    async def on_context_compacted(self) -> None:
        # Compaction rewrites history; the prior afk reminder may have been
        # summarized away, so let the next afk step restate the constraint.
        self._injected = False

    # afk 切换后重置，使下一步可注入最新的 afk 引导。
    async def on_afk_changed(self, enabled: bool) -> None:
        # A runtime toggle changes the latest truth about user presence.
        # Re-arm so the next LLM step can inject the current afk guidance.
        _ = enabled
        self._injected = False

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from kosong.message import Message

from kimi_cli.soul.dynamic_injection import DynamicInjection, DynamicInjectionProvider

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul

_READONLY_INJECTION_TYPE = "readonly_mode"

_READONLY_PROMPT = (
    "当前处于只读模式。"
    "当你需要修改代码时，请直接调用写操作工具（WriteFile、StrReplaceFile）或危险 Shell 命令。"
    "这些工具会在只读模式下被自动拦截，并将操作记录到待修改清单中，不会实际修改文件。"
    "用户可以发送 /pending 查看清单，发送 /pending-edit <序号> 修改某一项，发送 /pending-remove <序号> 删除单项，"
    "发送 /pending-clear 清空全部，发送 /execute 批量执行所有暂存的操作。"
    "不要只在文字中描述修改计划——直接调用工具，让系统自动收集待修改清单。"
    "如果某个工具被拦截返回错误，不要反复重试同一个操作。"
)


class ReadonlyModeInjectionProvider(DynamicInjectionProvider):
    """Injects a one-time reminder when readonly mode is active."""

    def __init__(self) -> None:
        self._injected: bool = False

    async def get_injections(
        self,
        history: Sequence[Message],
        soul: KimiSoul,
    ) -> list[DynamicInjection]:
        if not soul.is_readonly:
            self._injected = False
            return []
        if self._injected:
            return []
        self._injected = True
        return [DynamicInjection(type=_READONLY_INJECTION_TYPE, content=_READONLY_PROMPT)]

    async def on_context_compacted(self) -> None:
        # Compaction wipes history; the reminder may have been summarized away.
        # Clear the one-shot flag so the next step re-injects while readonly is active.
        self._injected = False

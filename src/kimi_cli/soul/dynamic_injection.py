from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from kosong.message import Message

from kimi_cli.notifications import is_notification_message

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul


@dataclass(frozen=True, slots=True)
class DynamicInjection:
    """A dynamic prompt content to be injected before an LLM step."""

    type: str  # identifier, e.g. "plan_mode"
    content: str  # text content (will be wrapped in <system-reminder> tags)


class DynamicInjectionProvider(ABC):
    """Base class for dynamic injection providers.

    Called before each LLM step. Implementations handle their own throttling.
    Providers can access all runtime state via the ``soul`` parameter
    (context_usage, runtime, config, etc.).
    """

    @abstractmethod
    async def get_injections(
        self,
        history: Sequence[Message],
        soul: KimiSoul,
    ) -> list[DynamicInjection]: ...

    async def on_context_compacted(self) -> None:
        """Called after the context is compacted (history is rebuilt).

        Override to reset internal throttling state when prior injections
        may have been collapsed into the compaction summary and are no
        longer literally present in history. Default is a no-op.
        """
        return None

    async def on_afk_changed(self, enabled: bool) -> None:
        """Called when afk mode is toggled at runtime.

        Override to reset internal throttling state when a mode-specific
        reminder should be eligible to fire again after a user toggle.
        """
        _ = enabled
        return None


def normalize_history(history: Sequence[Message]) -> list[Message]:
    """Merge adjacent user messages to produce a clean API input sequence.

    Dynamic injections are stored as standalone user messages in history;
    normalization merges them into the adjacent user message.

    Only ``user`` role messages are merged. Assistant and tool messages
    are never merged because their ``tool_calls`` / ``tool_call_id``
    fields form linked pairs that must stay intact.
    """
    if not history:
        return []

    result: list[Message] = []
    for msg in history:
        if (
            result
            and result[-1].role == msg.role
            and msg.role == "user"
            and not is_notification_message(result[-1])
            and not is_notification_message(msg)
        ):
            merged_content = list(result[-1].content) + list(msg.content)
            result[-1] = Message(role="user", content=merged_content)
        else:
            result.append(msg)
    return result

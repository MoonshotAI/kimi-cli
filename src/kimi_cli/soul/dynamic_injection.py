from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from kosong.message import Message, TextPart

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


# Placeholder body for synthetic tool responses inserted to repair an
# assistant ``tool_calls`` message whose matching ``tool`` response was lost
# (e.g. when the previous session was killed mid-turn under memory pressure).
# Kept short so it adds minimal context tokens on resume.
_ORPHAN_TOOL_PLACEHOLDER = (
    "(tool result unavailable: the previous session was interrupted before "
    "this tool call completed)"
)


def _repair_orphan_tool_calls(history: list[Message]) -> list[Message]:
    """Insert placeholder tool responses for any orphan ``tool_call_id``.

    A persisted assistant message can carry ``tool_calls`` without the
    matching ``tool`` role responses ever being flushed -- e.g. the CLI
    process was killed mid-turn or the worker crashed before the tool
    result was written. OpenAI-compatible providers then reject the next
    request with ``400 ... tool_call_ids did not have response messages``,
    permanently breaking conversation resume (regression #2336).

    Scan the history for assistant messages with ``tool_calls``, gather
    their declared ids, and check the immediately following ``tool`` role
    messages. For any id without a response, insert a synthetic placeholder
    so the API call shape stays valid. The stored history itself is left
    untouched -- only the sequence sent to the provider is patched.
    """
    if not history:
        return history
    result: list[Message] = []
    for i, msg in enumerate(history):
        result.append(msg)
        if msg.role != "assistant" or not msg.tool_calls:
            continue
        expected_ids = [tc.id for tc in msg.tool_calls if tc.id]
        if not expected_ids:
            continue
        seen: set[str] = set()
        for follower in history[i + 1 :]:
            if follower.role != "tool":
                break
            if follower.tool_call_id:
                seen.add(follower.tool_call_id)
        for expected_id in expected_ids:
            if expected_id in seen:
                continue
            result.append(
                Message(
                    role="tool",
                    content=[TextPart(text=_ORPHAN_TOOL_PLACEHOLDER)],
                    tool_call_id=expected_id,
                )
            )
    return result


def normalize_history(history: Sequence[Message]) -> list[Message]:
    """Merge adjacent user messages to produce a clean API input sequence.

    Dynamic injections are stored as standalone user messages in history;
    normalization merges them into the adjacent user message.

    Only ``user`` role messages are merged. Assistant and tool messages
    are never merged because their ``tool_calls`` / ``tool_call_id``
    fields form linked pairs that must stay intact.

    Orphan ``tool_calls`` whose tool responses were lost (e.g. mid-turn
    crash) are patched with placeholder ``tool`` messages so the provider
    request stays well-formed; see ``_repair_orphan_tool_calls``.
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
    return _repair_orphan_tool_calls(result)

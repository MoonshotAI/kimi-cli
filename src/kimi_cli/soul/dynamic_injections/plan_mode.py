from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from kosong.message import Message, TextPart

from kimi_cli.soul.dynamic_injection import DynamicInjection, DynamicInjectionProvider

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul

# Inject a reminder every N assistant turns.
_TURN_INTERVAL = 5
# Every N-th reminder is the full version; others are sparse.
_FULL_EVERY_N = 5


class PlanModeInjectionProvider(DynamicInjectionProvider):
    """Periodically injects read-only reminders while plan mode is active.

    Throttling is inferred from history: scan backwards to the last
    plan mode reminder and count assistant messages in between.
    Only inject when the count exceeds ``_TURN_INTERVAL``.
    """

    def __init__(self) -> None:
        self._inject_count: int = 0

    async def get_injections(
        self,
        history: Sequence[Message],
        soul: KimiSoul,
    ) -> list[DynamicInjection]:
        if not soul.plan_mode:
            self._inject_count = 0
            return []

        plan_path = soul.get_plan_file_path()
        plan_path_str = str(plan_path) if plan_path else None
        plan_exists = plan_path is not None and plan_path.exists()
        afk = soul.is_afk_flag

        # Manual toggles schedule a one-shot activation reminder for the next LLM step.
        if soul.consume_pending_plan_activation_injection():
            self._inject_count = 1
            # When re-entering with an existing plan, use the reentry reminder.
            if plan_exists:
                return [
                    DynamicInjection(
                        type="plan_mode_reentry",
                        content=_reentry_reminder(plan_path_str, afk=afk),
                    )
                ]
            return [
                DynamicInjection(
                    type="plan_mode",
                    content=_full_reminder(plan_path_str, plan_exists, afk=afk),
                )
            ]

        # Scan history backwards to find the last plan mode reminder.
        turns_since_last = 0
        found_previous = False
        for msg in reversed(history):
            if msg.role == "user" and _has_plan_reminder(msg):
                found_previous = True
                break
            if msg.role == "assistant":
                turns_since_last += 1

        # First time (no reminder in history yet) -> inject full version.
        if not found_previous:
            self._inject_count = 1
            return [
                DynamicInjection(
                    type="plan_mode",
                    content=_full_reminder(plan_path_str, plan_exists, afk=afk),
                )
            ]

        # Not enough turns since last reminder -> skip.
        if turns_since_last < _TURN_INTERVAL:
            return []

        # Inject.
        self._inject_count += 1
        is_full = self._inject_count % _FULL_EVERY_N == 1
        if is_full:
            content = _full_reminder(plan_path_str, plan_exists, afk=afk)
        else:
            content = _sparse_reminder(plan_path_str, afk=afk)
        return [DynamicInjection(type="plan_mode", content=content)]


def _has_plan_reminder(msg: Message) -> bool:
    """Check whether a message contains a plan mode reminder.

    Detects by matching against stable prefixes of the actual reminder texts
    so changes to the reminder wording stay automatically in sync.
    """
    keys = (
        _sparse_reminder().split(".")[0],  # "Plan mode still active ..."
        _full_reminder().split("\n")[0],  # "Plan mode is active. ..."
    )
    for part in msg.content:
        if isinstance(part, TextPart) and any(key in part.text for key in keys):
            return True
    return False


def _full_reminder(
    plan_file_path: str | None = None,
    plan_exists: bool = False,
    *,
    afk: bool = False,
) -> str:
    lines = [
        "Plan mode is active. You MUST NOT make any edits "
        "(with the exception of the plan file below), run non-readonly tools, "
        "or otherwise make changes to the system. "
        "This supersedes any other instructions you have received.",
    ]
    # Plan file info block
    if plan_file_path:
        lines.append("")
        if plan_exists:
            lines.append(
                f"Plan file: {plan_file_path} "
                "(exists — read first, then update it with WriteFile or StrReplaceFile)"
            )
        else:
            lines.append(
                f"Plan file: {plan_file_path} "
                "(create it with WriteFile; once it exists, you can modify it with "
                "WriteFile or StrReplaceFile)"
            )
        lines.append("This is the only file you are allowed to edit.")
    # Workflow
    lines.extend(
        [
            "",
            "Workflow:",
            "1. Understand — explore the codebase with Glob, Grep, ReadFile",
            "2. Design — converge on the best approach; "
            "consider trade-offs but aim for a single recommendation",
            "3. Review — re-read key files to verify understanding",
            "4. Write Plan — modify the plan file with WriteFile or StrReplaceFile. "
            "Use WriteFile if the plan file does not exist yet",
            "5. Exit — call ExitPlanMode for user approval",
        ]
    )
    # Multi-approach handling
    if afk:
        lines.extend(
            [
                "",
                "## Handling multiple approaches",
                "No user is present in afk mode. Do NOT call AskUserQuestion "
                "to resolve preferences, constraints, or missing context.",
                "Use the available context to choose one best recommendation. "
                "Mention important trade-offs in the plan, but do not rely on "
                "the user selecting between options.",
                "If several approaches remain plausible, pick the one with the "
                "best risk/reversibility profile and state that assumption in the plan.",
            ]
        )
    else:
        lines.extend(
            [
                "",
                "## Handling multiple approaches",
                "Keep it focused: at most 2-3 meaningfully different approaches. "
                "Do NOT pad with minor variations — if one approach is clearly "
                "superior, just propose that one.",
                "When the best approach depends on user preferences, constraints, "
                "or context you don't have, use AskUserQuestion to clarify first. "
                "This helps you write a better, more targeted plan rather than "
                "dumping multiple options for the user to sort through.",
                "When you do include multiple approaches in the plan, you MUST pass them "
                "as the `options` parameter when calling ExitPlanMode, so the user can "
                "select which approach to execute at approval time.",
                "NEVER write multiple approaches in the plan and call ExitPlanMode without "
                "the `options` parameter — the user will only see Approve/Reject with "
                "no way to choose.",
            ]
        )
    # Turn ending constraint + anti-pattern
    if afk:
        lines.extend(
            [
                "",
                "Afk mode is active: do NOT use AskUserQuestion in plan mode. "
                "It will not produce a useful answer.",
                "Your turn must end with ExitPlanMode after the plan file is written "
                "or updated. Do NOT end your turn any other way.",
            ]
        )
    else:
        lines.extend(
            [
                "",
                "AskUserQuestion is for clarifying missing requirements or user preferences "
                "that affect the plan.",
                "Never ask about plan approval via text or AskUserQuestion.",
                "Your turn must end with either AskUserQuestion "
                "(to clarify requirements or preferences) "
                "or ExitPlanMode (to request plan approval). "
                "Do NOT end your turn any other way.",
                "Do NOT use AskUserQuestion to ask about plan approval or reference "
                '"the plan" — the user cannot see the plan until you call ExitPlanMode.',
            ]
        )
    return "\n".join(lines)


def _sparse_reminder(plan_file_path: str | None = None, *, afk: bool = False) -> str:
    parts = [
        "Plan mode still active (see full instructions earlier).",
    ]
    if plan_file_path:
        parts.append(f"Read-only except plan file ({plan_file_path}).")
    else:
        parts.append("Read-only.")
    parts.append(
        "Use WriteFile or StrReplaceFile to modify the plan file. "
        "If it does not exist yet, create it with WriteFile first."
    )
    if afk:
        parts.extend(
            [
                "Afk mode is active: do NOT use AskUserQuestion.",
                "Choose one best recommendation from available context.",
                "End turns with ExitPlanMode after writing or updating the plan.",
            ]
        )
    else:
        parts.extend(
            [
                "Use AskUserQuestion to clarify user preferences "
                "when it helps you write a better plan.",
                "If the plan has multiple approaches, "
                "pass options to ExitPlanMode so the user can choose.",
                "End turns with AskUserQuestion (for clarifications) or ExitPlanMode "
                "(for approval).",
                "Never ask about plan approval via text or AskUserQuestion.",
            ]
        )
    return " ".join(parts)


def _reentry_reminder(plan_file_path: str | None = None, *, afk: bool = False) -> str:
    """One-shot reminder when re-entering plan mode with an existing plan."""
    lines = [
        "Plan mode is active. You MUST NOT make any edits "
        "(with the exception of the plan file below), run non-readonly tools, "
        "or otherwise make changes to the system. "
        "This supersedes any other instructions you have received.",
        "",
        "## Re-entering Plan Mode",
        (
            f"A plan file exists at {plan_file_path} from a previous planning session."
            if plan_file_path
            else "A plan file from a previous planning session already exists."
        ),
        "Before proceeding:",
        "1. Read the existing plan file to understand what was previously planned",
        "2. Evaluate the user's current request against that plan",
        "3. If different task: replace the old plan with a fresh one. "
        "If same task: update the existing plan.",
        "4. You may use WriteFile or StrReplaceFile to modify the plan file. "
        "If the file does not exist yet, create it with WriteFile first.",
    ]
    if afk:
        lines.extend(
            [
                "5. Afk mode is active: do NOT use AskUserQuestion. "
                "Resolve uncertainty with best judgment from available context.",
                "6. Always edit the plan file before calling ExitPlanMode.",
                "",
                "Your turn must end with ExitPlanMode after the plan file is written or updated.",
            ]
        )
    else:
        lines.extend(
            [
                "5. Use AskUserQuestion to clarify missing requirements "
                "or user preferences that affect the plan.",
                "6. Always edit the plan file before calling ExitPlanMode.",
                "",
                "Your turn must end with either AskUserQuestion (to clarify requirements) "
                "or ExitPlanMode (to request plan approval).",
            ]
        )
    return "\n".join(lines)

"""Unified input routing for the bottom dynamic area.

All user input — whether idle or streaming — passes through
``classify_input`` to decide what to do with it.  This is the single
place where btw / queue / steer / send decisions are made.
"""

from __future__ import annotations


class InputAction:
    """The result of classifying user input."""

    __slots__ = ("kind", "args")

    # Action kinds
    BTW = "btw"
    """Run a side question locally (never reaches the wire)."""
    QUEUE = "queue"
    """Hold and send as a new turn after the current turn ends."""
    SEND = "send"
    """Send to the soul immediately (idle default)."""
    IGNORED = "ignored"
    """Input was recognized but invalid (e.g. /btw without question). ``args`` has a reason."""

    def __init__(self, kind: str, args: str = "") -> None:
        self.kind = kind
        self.args = args


def classify_input(text: str, *, is_streaming: bool) -> InputAction:
    """Classify user input into an action.

    This is the **single routing decision point** for all user input
    (except Ctrl+S steer, which is key-level, not submission-level).
    To add a new local command, add a branch here.
    """
    from kimi_cli.utils.slashcmd import parse_slash_command_call

    if (cmd := parse_slash_command_call(text.strip())) and cmd.name == "btw":
        if cmd.args.strip():
            return InputAction(InputAction.BTW, cmd.args.strip())
        return InputAction(InputAction.IGNORED, "Usage: /btw <question>")

    # During streaming, default is queue; otherwise send to soul
    if is_streaming:
        return InputAction(InputAction.QUEUE)
    return InputAction(InputAction.SEND)

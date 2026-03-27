from __future__ import annotations

import shutil

from kosong.message import Message
from rich.console import Group
from rich.text import Text

from kimi_cli.ui.shell.prompt import PROMPT_SYMBOL
from kimi_cli.utils.message import message_stringify


def _separator_line() -> Text:
    """Return a dashed separator line that spans the full terminal width."""
    try:
        width = shutil.get_terminal_size().columns
    except OSError:
        width = 80
    return Text("-" * width, style="grey50")


def render_user_echo(message: Message) -> Group:
    """Render a user message as literal shell transcript text."""
    user_line = Text(f"{PROMPT_SYMBOL} {message_stringify(message)}", style="#007AFF")
    return Group(user_line, _separator_line())


def render_user_echo_text(text: str) -> Group:
    """Render the local prompt text exactly as the user saw it in the buffer."""
    user_line = Text(f"{PROMPT_SYMBOL} {text}", style="#007AFF")
    return Group(user_line, _separator_line())

from __future__ import annotations

from kosong.message import Message
from rich.text import Text

from kimi_cli.ui.shell.prompt import PROMPT_SYMBOL
from kimi_cli.utils.message import message_stringify


def render_user_echo(message: Message) -> Text:
    """Render a user message as literal shell transcript text."""
    return Text(f"{PROMPT_SYMBOL} {message_stringify(message)}")


def render_user_echo_text(text: str) -> Text:
    """Render the local prompt text exactly as the user saw it in the buffer."""
    return Text(f"{PROMPT_SYMBOL} {text}")

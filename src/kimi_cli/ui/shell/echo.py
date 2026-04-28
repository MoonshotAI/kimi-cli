from __future__ import annotations

from kosong.message import Message
from rich.text import Text

from kimi_cli.ui.shell.prompt import PROMPT_SYMBOL
from kimi_cli.ui.theme import get_user_prompt_color
from kimi_cli.utils.message import message_stringify


def render_user_echo(message: Message) -> Text:
    """Render a user message as literal shell transcript text."""
    text_color = get_user_prompt_color()

    text = Text()
    text.append(f"{PROMPT_SYMBOL} ")
    text.append(message_stringify(message), style=text_color or "")
    return text


def render_user_echo_text(text: str) -> Text:
    """Render the local prompt text exactly as the user saw it in the buffer."""
    text_color = get_user_prompt_color()

    result = Text()
    result.append(f"{PROMPT_SYMBOL} ")
    result.append(text, style=text_color or "")
    return result

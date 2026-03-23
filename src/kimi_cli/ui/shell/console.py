from __future__ import annotations

from rich.console import Console, RenderableType
from rich.theme import Theme

NEUTRAL_MARKDOWN_THEME = Theme(
    {
        "markdown.paragraph": "none",
        "markdown.block_quote": "none",
        "markdown.hr": "none",
        "markdown.item": "none",
        "markdown.item.bullet": "none",
        "markdown.item.number": "none",
        "markdown.link": "none",
        "markdown.link_url": "none",
        "markdown.h1": "none",
        "markdown.h1.border": "none",
        "markdown.h2": "none",
        "markdown.h3": "none",
        "markdown.h4": "none",
        "markdown.h5": "none",
        "markdown.h6": "none",
        "markdown.em": "none",
        "markdown.strong": "none",
        "markdown.s": "none",
        "status.spinner": "none",
    },
    inherit=True,
)

_NEUTRAL_MARKDOWN_THEME = NEUTRAL_MARKDOWN_THEME
console = Console(highlight=False, theme=NEUTRAL_MARKDOWN_THEME)


def render_to_ansi(renderable: RenderableType, *, columns: int) -> str:
    """Render a Rich renderable to an ANSI string for prompt_toolkit integration."""
    from io import StringIO

    width = max(20, columns)
    buf = StringIO()
    temp = Console(
        file=buf,
        force_terminal=True,
        color_system="truecolor",
        width=width,
        theme=NEUTRAL_MARKDOWN_THEME,
        highlight=False,
    )
    temp.print(renderable, end="")
    return buf.getvalue()

from __future__ import annotations

from typing import Any

from pygments.token import (
    Comment,
    Generic,
    Keyword,
    Name,
    Number,
    Operator,
    Punctuation,
    String,
)
from pygments.token import (
    Literal as PygmentsLiteral,
)
from pygments.token import (
    Text as PygmentsText,
)
from pygments.token import (
    Token as PygmentsToken,
)
from rich.style import Style
from rich.syntax import ANSISyntaxTheme, Syntax, SyntaxTheme

KIMI_ANSI_THEME_NAME = "kimi-ansi"
KIMI_ANSI_THEME = ANSISyntaxTheme(
    {
        PygmentsToken: Style(color="default"),
        PygmentsText: Style(color="default"),
        Comment: Style(color="bright_black", italic=True),
        Keyword: Style(color="bright_magenta", bold=True),
        Keyword.Constant: Style(color="bright_magenta", bold=True),
        Keyword.Declaration: Style(color="bright_magenta", bold=True),
        Keyword.Namespace: Style(color="bright_magenta", bold=True),
        Keyword.Pseudo: Style(color="bright_magenta"),
        Keyword.Reserved: Style(color="bright_magenta", bold=True),
        Keyword.Type: Style(color="bright_magenta", bold=True),
        Name: Style(color="default"),
        Name.Attribute: Style(color="cyan"),
        Name.Builtin: Style(color="bright_cyan"),
        Name.Builtin.Pseudo: Style(color="bright_magenta"),
        Name.Builtin.Type: Style(color="bright_cyan", bold=True),
        Name.Class: Style(color="bright_cyan", bold=True),
        Name.Constant: Style(color="bright_magenta"),
        Name.Decorator: Style(color="bright_magenta"),
        Name.Entity: Style(color="bright_cyan"),
        Name.Exception: Style(color="bright_magenta", bold=True),
        Name.Function: Style(color="bright_blue"),
        Name.Label: Style(color="bright_cyan"),
        Name.Namespace: Style(color="bright_cyan"),
        Name.Other: Style(color="bright_blue"),
        Name.Property: Style(color="bright_blue"),
        Name.Tag: Style(color="bright_blue"),
        Name.Variable: Style(color="bright_blue"),
        PygmentsLiteral: Style(color="bright_green"),
        PygmentsLiteral.Date: Style(color="green"),
        String: Style(color="yellow"),
        String.Doc: Style(color="yellow", italic=True),
        String.Interpol: Style(color="yellow"),
        String.Affix: Style(color="yellow"),
        Number: Style(color="bright_green"),
        Operator: Style(color="default"),
        Punctuation: Style(color="default"),
        Generic.Deleted: Style(color="red"),
        Generic.Emph: Style(italic=True),
        Generic.Error: Style(color="bright_red", bold=True),
        Generic.Heading: Style(color="bright_cyan", bold=True),
        Generic.Inserted: Style(color="green"),
        Generic.Output: Style(color="bright_black"),
        Generic.Prompt: Style(color="bright_magenta"),
        Generic.Strong: Style(bold=True),
        Generic.Subheading: Style(color="bright_cyan"),
        Generic.Traceback: Style(color="bright_red", bold=True),
    }
)


def resolve_code_theme(theme: str | SyntaxTheme) -> str | SyntaxTheme:
    if isinstance(theme, str) and theme.lower() == KIMI_ANSI_THEME_NAME:
        return KIMI_ANSI_THEME
    return theme


class KimiSyntax(Syntax):
    def __init__(self, code: str, lexer: str, **kwargs: Any) -> None:
        if "theme" not in kwargs or kwargs["theme"] is None:
            kwargs["theme"] = KIMI_ANSI_THEME
        super().__init__(code, lexer, **kwargs)


if __name__ == "__main__":
    from rich.console import Console
    from rich.text import Text

    console = Console()

    examples = [
        ("diff", "diff", "@@ -1,2 +1,2 @@\n-line one\n+line uno\n"),
        (
            "python",
            "python",
            'def greet(name: str) -> str:\n    return f"Hi, {name}!"\n',
        ),
        ("bash", "bash", "set -euo pipefail\nprintf '%s\\n' \"hello\"\n"),
    ]

    for idx, (title, lexer, code) in enumerate(examples):
        if idx:
            console.print()
        console.print(Text(f"[{title}]", style="bold"))
        console.print(KimiSyntax(code, lexer))

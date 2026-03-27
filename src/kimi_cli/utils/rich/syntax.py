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
        Keyword: Style(color="magenta"),
        Keyword.Constant: Style(color="cyan"),
        Keyword.Declaration: Style(color="magenta"),
        Keyword.Namespace: Style(color="magenta"),
        Keyword.Pseudo: Style(color="magenta"),
        Keyword.Reserved: Style(color="magenta"),
        Keyword.Type: Style(color="magenta"),
        Name: Style(color="default"),
        Name.Attribute: Style(color="cyan"),
        Name.Builtin: Style(color="bright_yellow"),
        Name.Builtin.Pseudo: Style(color="cyan"),
        Name.Builtin.Type: Style(color="bright_yellow", bold=True),
        Name.Class: Style(color="bright_yellow", bold=True),
        Name.Constant: Style(color="cyan"),
        Name.Decorator: Style(color="bright_cyan"),
        Name.Entity: Style(color="bright_yellow"),
        Name.Exception: Style(color="bright_yellow", bold=True),
        Name.Function: Style(color="bright_cyan"),
        Name.Label: Style(color="cyan"),
        Name.Namespace: Style(color="magenta"),
        Name.Other: Style(color="bright_cyan"),
        Name.Property: Style(color="cyan"),
        Name.Tag: Style(color="bright_green"),
        Name.Variable: Style(color="bright_yellow"),
        PygmentsLiteral: Style(color="bright_blue"),
        PygmentsLiteral.Date: Style(color="bright_blue"),
        String: Style(color="bright_blue"),
        String.Doc: Style(color="bright_blue", italic=True),
        String.Interpol: Style(color="bright_blue"),
        String.Affix: Style(color="cyan"),
        Number: Style(color="cyan"),
        Operator: Style(color="default"),
        Operator.Word: Style(color="magenta"),
        Punctuation: Style(color="default"),
        Generic.Deleted: Style(color="red"),
        Generic.Emph: Style(italic=True),
        Generic.Error: Style(color="bright_red", bold=True),
        Generic.Heading: Style(color="cyan", bold=True),
        Generic.Inserted: Style(color="green"),
        Generic.Output: Style(color="bright_black"),
        Generic.Prompt: Style(color="bright_cyan"),
        Generic.Strong: Style(bold=True),
        Generic.Subheading: Style(color="cyan"),
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

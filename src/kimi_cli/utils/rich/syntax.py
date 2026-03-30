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

# Dark theme (default) - uses terminal's default foreground (white/light gray on dark bg)
KIMI_ANSI_THEME_DARK = ANSISyntaxTheme(
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

# Light theme - uses dark colors for visibility on light backgrounds
KIMI_ANSI_THEME_LIGHT = ANSISyntaxTheme(
    {
        PygmentsToken: Style(color="black"),
        PygmentsText: Style(color="black"),
        Comment: Style(color="grey50", italic=True),
        Keyword: Style(color="dark_magenta"),
        Keyword.Constant: Style(color="dark_cyan"),
        Keyword.Declaration: Style(color="dark_magenta"),
        Keyword.Namespace: Style(color="dark_magenta"),
        Keyword.Pseudo: Style(color="dark_magenta"),
        Keyword.Reserved: Style(color="dark_magenta"),
        Keyword.Type: Style(color="dark_magenta"),
        Name: Style(color="black"),
        Name.Attribute: Style(color="dark_cyan"),
        Name.Builtin: Style(color="dark_orange3"),
        Name.Builtin.Pseudo: Style(color="dark_cyan"),
        Name.Builtin.Type: Style(color="dark_orange3", bold=True),
        Name.Class: Style(color="dark_orange3", bold=True),
        Name.Constant: Style(color="dark_cyan"),
        Name.Decorator: Style(color="dark_cyan", bold=True),
        Name.Entity: Style(color="dark_orange3"),
        Name.Exception: Style(color="dark_orange3", bold=True),
        Name.Function: Style(color="dark_cyan", bold=True),
        Name.Label: Style(color="dark_cyan"),
        Name.Namespace: Style(color="dark_magenta"),
        Name.Other: Style(color="dark_cyan", bold=True),
        Name.Property: Style(color="dark_cyan"),
        Name.Tag: Style(color="dark_green"),
        Name.Variable: Style(color="dark_orange3"),
        PygmentsLiteral: Style(color="dark_blue"),
        PygmentsLiteral.Date: Style(color="dark_blue"),
        String: Style(color="dark_blue"),
        String.Doc: Style(color="dark_blue", italic=True),
        String.Interpol: Style(color="dark_blue"),
        String.Affix: Style(color="dark_cyan"),
        Number: Style(color="dark_cyan"),
        Operator: Style(color="black"),
        Operator.Word: Style(color="dark_magenta"),
        Punctuation: Style(color="black"),
        Generic.Deleted: Style(color="dark_red"),
        Generic.Emph: Style(italic=True),
        Generic.Error: Style(color="red", bold=True),
        Generic.Heading: Style(color="dark_cyan", bold=True),
        Generic.Inserted: Style(color="dark_green"),
        Generic.Output: Style(color="grey50"),
        Generic.Prompt: Style(color="dark_cyan"),
        Generic.Strong: Style(bold=True),
        Generic.Subheading: Style(color="dark_cyan"),
        Generic.Traceback: Style(color="red", bold=True),
    }
)

# Backward compatibility alias
KIMI_ANSI_THEME = KIMI_ANSI_THEME_DARK


def resolve_code_theme(theme: str | SyntaxTheme) -> str | SyntaxTheme:
    if isinstance(theme, str) and theme.lower() == KIMI_ANSI_THEME_NAME:
        from kimi_cli.ui.shell.theme import is_light_theme

        return KIMI_ANSI_THEME_LIGHT if is_light_theme() else KIMI_ANSI_THEME_DARK
    return theme


class KimiSyntax(Syntax):
    def __init__(self, code: str, lexer: str, **kwargs: Any) -> None:
        if "theme" not in kwargs or kwargs["theme"] is None:
            from kimi_cli.ui.shell.theme import is_light_theme

            kwargs["theme"] = KIMI_ANSI_THEME_LIGHT if is_light_theme() else KIMI_ANSI_THEME_DARK
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

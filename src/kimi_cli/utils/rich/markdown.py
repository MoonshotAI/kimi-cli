# This file is modified from https://github.com/Textualize/rich/blob/4d6d631a3d2deddf8405522d4b8c976a6d35726c/rich/markdown.py
# pyright: standard

from __future__ import annotations

import sys
from collections.abc import Iterable, Mapping
from typing import ClassVar, get_args

from markdown_it import MarkdownIt
from markdown_it.token import Token
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
from rich import box
from rich._loop import loop_first
from rich._stack import Stack
from rich.console import Console, ConsoleOptions, JustifyMethod, RenderResult
from rich.containers import Renderables
from rich.jupyter import JupyterMixin
from rich.rule import Rule
from rich.segment import Segment
from rich.style import Style, StyleStack
from rich.syntax import ANSISyntaxTheme, Syntax, SyntaxTheme
from rich.table import Table
from rich.text import Text, TextType

LIST_INDENT_WIDTH = 2

_FALLBACK_STYLES: Mapping[str, Style] = {
    "markdown.paragraph": Style(),
    "markdown.h1": Style(color="bright_white", bold=True),
    "markdown.h1.underline": Style(color="bright_white", bold=True),
    "markdown.h2": Style(color="white", bold=True, underline=True),
    "markdown.h3": Style(bold=True),
    "markdown.h4": Style(bold=True),
    "markdown.h5": Style(bold=True),
    "markdown.h6": Style(dim=True, italic=True),
    "markdown.code": Style(color="bright_cyan", bold=True),
    "markdown.code_block": Style(color="bright_cyan"),
    "markdown.item": Style(),
    "markdown.item.bullet": Style(),
    "markdown.item.number": Style(),
    "markdown.em": Style(italic=True),
    "markdown.strong": Style(bold=True),
    "markdown.s": Style(strike=True),
    "markdown.link": Style(color="bright_blue", underline=True),
    "markdown.link_url": Style(color="cyan", underline=True),
    "markdown.block_quote": Style(),
    "markdown.hr": Style(color="grey58"),
}

_KIMI_ANSI_THEME_NAME = "kimi-ansi"
_KIMI_ANSI_THEME = ANSISyntaxTheme(
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


def _resolve_code_theme(theme: str) -> str | SyntaxTheme:
    if theme.lower() == _KIMI_ANSI_THEME_NAME:
        return _KIMI_ANSI_THEME
    return theme


def _strip_background(text: Text) -> Text:
    """Return a copy of ``text`` with all background colors removed."""

    clean = Text(
        text.plain,
        justify=text.justify,
        overflow=text.overflow,
        no_wrap=text.no_wrap,
        end=text.end,
        tab_size=text.tab_size,
    )

    if text.style:
        base_style = text.style
        if not isinstance(base_style, Style):
            base_style = Style.parse(str(base_style))
        base_style = base_style.copy()
        if base_style._bgcolor is not None:
            base_style._bgcolor = None
        clean.stylize(base_style, 0, len(clean))

    for span in text.spans:
        style = span.style
        if style is None:
            continue
        new_style = Style.parse(str(style)) if not isinstance(style, Style) else style.copy()
        if new_style._bgcolor is not None:
            new_style._bgcolor = None
        clean.stylize(new_style, span.start, span.end)

    return clean


class MarkdownElement:
    new_line: ClassVar[bool] = True

    @classmethod
    def create(cls, markdown: Markdown, token: Token) -> MarkdownElement:
        """Factory to create markdown element,

        Args:
            markdown (Markdown): The parent Markdown object.
            token (Token): A node from markdown-it.

        Returns:
            MarkdownElement: A new markdown element
        """
        return cls()

    def on_enter(self, context: MarkdownContext) -> None:
        """Called when the node is entered.

        Args:
            context (MarkdownContext): The markdown context.
        """

    def on_text(self, context: MarkdownContext, text: TextType) -> None:
        """Called when text is parsed.

        Args:
            context (MarkdownContext): The markdown context.
        """

    def on_leave(self, context: MarkdownContext) -> None:
        """Called when the parser leaves the element.

        Args:
            context (MarkdownContext): [description]
        """

    def on_child_close(self, context: MarkdownContext, child: MarkdownElement) -> bool:
        """Called when a child element is closed.

        This method allows a parent element to take over rendering of its children.

        Args:
            context (MarkdownContext): The markdown context.
            child (MarkdownElement): The child markdown element.

        Returns:
            bool: Return True to render the element, or False to not render the element.
        """
        return True

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        return ()


class UnknownElement(MarkdownElement):
    """An unknown element.

    Hopefully there will be no unknown elements, and we will have a MarkdownElement for
    everything in the document.

    """


class TextElement(MarkdownElement):
    """Base class for elements that render text."""

    style_name = "none"

    def on_enter(self, context: MarkdownContext) -> None:
        self.style = context.enter_style(self.style_name)
        self.text = Text(justify="left")

    def on_text(self, context: MarkdownContext, text: TextType) -> None:
        self.text.append(text, context.current_style if isinstance(text, str) else None)

    def on_leave(self, context: MarkdownContext) -> None:
        context.leave_style()


class Paragraph(TextElement):
    """A Paragraph."""

    style_name = "markdown.paragraph"
    justify: JustifyMethod

    @classmethod
    def create(cls, markdown: Markdown, token: Token) -> Paragraph:
        return cls(justify=markdown.justify or "left")

    def __init__(self, justify: JustifyMethod) -> None:
        self.justify = justify

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        self.text.justify = self.justify
        yield self.text


class Heading(TextElement):
    """A heading."""

    @classmethod
    def create(cls, markdown: Markdown, token: Token) -> Heading:
        return cls(token.tag)

    def on_enter(self, context: MarkdownContext) -> None:
        self.text = Text()
        context.enter_style(self.style_name)

    def __init__(self, tag: str) -> None:
        self.tag = tag
        self.style_name = f"markdown.{tag}"
        super().__init__()

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        text = self.text
        text.justify = "left"
        width = max(1, text.cell_len)

        if self.tag == "h1":
            underline = Text("═" * width)
            underline.stylize("markdown.h1.underline")
            yield text
            yield underline
        else:
            yield text


class CodeBlock(TextElement):
    """A code block with syntax highlighting."""

    style_name = "markdown.code_block"

    @classmethod
    def create(cls, markdown: Markdown, token: Token) -> CodeBlock:
        node_info = token.info or ""
        lexer_name = node_info.partition(" ")[0]
        return cls(lexer_name or "text", markdown.code_theme)

    def __init__(self, lexer_name: str, theme: str | SyntaxTheme) -> None:
        self.lexer_name = lexer_name
        self.theme = theme

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        code = str(self.text).rstrip()
        syntax = Syntax(
            code,
            self.lexer_name,
            theme=self.theme,
            word_wrap=True,
            background_color=None,
            padding=0,
        )
        highlighted = syntax.highlight(code)
        highlighted.rstrip()
        stripped = _strip_background(highlighted)
        stripped.rstrip()
        yield stripped


class BlockQuote(TextElement):
    """A block quote."""

    style_name = "markdown.block_quote"

    def __init__(self) -> None:
        self.elements: Renderables = Renderables()

    def on_child_close(self, context: MarkdownContext, child: MarkdownElement) -> bool:
        self.elements.append(child)
        return False

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        render_options = options.update(width=options.max_width - 4)
        style = self.style.without_color
        lines = console.render_lines(self.elements, render_options, style=style)
        new_line = Segment("\n")
        padding = Segment("▌ ", style)
        for line in lines:
            yield padding
            yield from line
            yield new_line


class HorizontalRule(MarkdownElement):
    """A horizontal rule to divide sections."""

    new_line = False

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        style = _FALLBACK_STYLES["markdown.hr"].copy()
        yield Rule(style=style)


class TableElement(MarkdownElement):
    """MarkdownElement corresponding to `table_open`."""

    def __init__(self) -> None:
        self.header: TableHeaderElement | None = None
        self.body: TableBodyElement | None = None

    def on_child_close(self, context: MarkdownContext, child: MarkdownElement) -> bool:
        if isinstance(child, TableHeaderElement):
            self.header = child
        elif isinstance(child, TableBodyElement):
            self.body = child
        else:
            raise RuntimeError("Couldn't process markdown table.")
        return False

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        table = Table(box=box.SIMPLE_HEAVY, show_edge=False)

        if self.header is not None and self.header.row is not None:
            for column in self.header.row.cells:
                table.add_column(column.content)

        if self.body is not None:
            for row in self.body.rows:
                row_content = [element.content for element in row.cells]
                table.add_row(*row_content)

        yield table


class TableHeaderElement(MarkdownElement):
    """MarkdownElement corresponding to `thead_open` and `thead_close`."""

    def __init__(self) -> None:
        self.row: TableRowElement | None = None

    def on_child_close(self, context: MarkdownContext, child: MarkdownElement) -> bool:
        assert isinstance(child, TableRowElement)
        self.row = child
        return False


class TableBodyElement(MarkdownElement):
    """MarkdownElement corresponding to `tbody_open` and `tbody_close`."""

    def __init__(self) -> None:
        self.rows: list[TableRowElement] = []

    def on_child_close(self, context: MarkdownContext, child: MarkdownElement) -> bool:
        assert isinstance(child, TableRowElement)
        self.rows.append(child)
        return False


class TableRowElement(MarkdownElement):
    """MarkdownElement corresponding to `tr_open` and `tr_close`."""

    def __init__(self) -> None:
        self.cells: list[TableDataElement] = []

    def on_child_close(self, context: MarkdownContext, child: MarkdownElement) -> bool:
        assert isinstance(child, TableDataElement)
        self.cells.append(child)
        return False


class TableDataElement(MarkdownElement):
    """MarkdownElement corresponding to `td_open` and `td_close`
    and `th_open` and `th_close`."""

    @classmethod
    def create(cls, markdown: Markdown, token: Token) -> MarkdownElement:
        style = str(token.attrs.get("style")) or ""

        justify: JustifyMethod
        if "text-align:right" in style:
            justify = "right"
        elif "text-align:center" in style:
            justify = "center"
        elif "text-align:left" in style:
            justify = "left"
        else:
            justify = "default"

        assert justify in get_args(JustifyMethod)
        return cls(justify=justify)

    def __init__(self, justify: JustifyMethod) -> None:
        self.content: Text = Text("", justify=justify)
        self.justify = justify

    def on_text(self, context: MarkdownContext, text: TextType) -> None:
        text = Text(text) if isinstance(text, str) else text
        text.stylize(context.current_style)
        self.content.append_text(text)


class ListElement(MarkdownElement):
    """A list element."""

    @classmethod
    def create(cls, markdown: Markdown, token: Token) -> ListElement:
        return cls(token.type, int(token.attrs.get("start", 1)))

    def __init__(self, list_type: str, list_start: int | None) -> None:
        self.items: list[ListItem] = []
        self.list_type = list_type
        self.list_start = list_start

    def on_child_close(self, context: MarkdownContext, child: MarkdownElement) -> bool:
        assert isinstance(child, ListItem)
        self.items.append(child)
        return False

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        if self.list_type == "bullet_list_open":
            for item in self.items:
                yield from item.render_bullet(console, options)
        else:
            number = 1 if self.list_start is None else self.list_start
            last_number = number + len(self.items)
            for index, item in enumerate(self.items):
                yield from item.render_number(console, options, number + index, last_number)


class ListItem(TextElement):
    """An item in a list."""

    style_name = "markdown.item"

    @staticmethod
    def _line_starts_with_list_marker(text: str) -> bool:
        stripped = text.lstrip()
        if not stripped:
            return False
        if stripped.startswith(("• ", "- ", "* ")):
            return True
        index = 0
        while index < len(stripped) and stripped[index].isdigit():
            index += 1
        if index == 0 or index >= len(stripped):
            return False
        marker = stripped[index]
        has_space = index + 1 < len(stripped) and stripped[index + 1] == " "
        return marker in {".", ")"} and has_space

    @classmethod
    def create(cls, markdown: Markdown, token: Token) -> MarkdownElement:
        # `list_item_open` levels grow by 2 for each nested list depth.
        depth = max(0, (token.level - 1) // 2)
        return cls(indent=depth)

    def __init__(self, indent: int = 0) -> None:
        self.indent = indent
        self.elements: Renderables = Renderables()

    def on_child_close(self, context: MarkdownContext, child: MarkdownElement) -> bool:
        self.elements.append(child)
        return False

    def render_bullet(self, console: Console, options: ConsoleOptions) -> RenderResult:
        lines = console.render_lines(self.elements, options, style=self.style)
        indent_padding_len = LIST_INDENT_WIDTH * self.indent
        indent_text = " " * indent_padding_len
        bullet = Segment("• ")
        new_line = Segment("\n")
        bullet_width = len(bullet.text)
        for first, line in loop_first(lines):
            if first:
                if indent_text:
                    yield Segment(indent_text)
                yield bullet
            else:
                plain = "".join(segment.text for segment in line)
                if self._line_starts_with_list_marker(plain):
                    prefix = ""
                else:
                    existing = len(plain) - len(plain.lstrip(" "))
                    target = indent_padding_len + bullet_width
                    missing = max(0, target - existing)
                    prefix = " " * missing
                if prefix:
                    yield Segment(prefix)
            yield from line
            yield new_line

    def render_number(
        self, console: Console, options: ConsoleOptions, number: int, last_number: int
    ) -> RenderResult:
        lines = console.render_lines(self.elements, options, style=self.style)
        new_line = Segment("\n")
        indent_padding_len = LIST_INDENT_WIDTH * self.indent
        indent_text = " " * indent_padding_len
        numeral_text = f"{number}. "
        numeral = Segment(numeral_text)
        numeral_width = len(numeral_text)
        for first, line in loop_first(lines):
            if first:
                if indent_text:
                    yield Segment(indent_text)
                yield numeral
            else:
                plain = "".join(segment.text for segment in line)
                if self._line_starts_with_list_marker(plain):
                    prefix = ""
                else:
                    existing = len(plain) - len(plain.lstrip(" "))
                    target = indent_padding_len + numeral_width
                    missing = max(0, target - existing)
                    prefix = " " * missing
                if prefix:
                    yield Segment(prefix)
            yield from line
            yield new_line


class Link(TextElement):
    @classmethod
    def create(cls, markdown: Markdown, token: Token) -> MarkdownElement:
        url = token.attrs.get("href", "#")
        return cls(token.content, str(url))

    def __init__(self, text: str, href: str):
        self.text = Text(text)
        self.href = href


class ImageItem(TextElement):
    """Renders a placeholder for an image."""

    new_line = False

    @classmethod
    def create(cls, markdown: Markdown, token: Token) -> MarkdownElement:
        """Factory to create markdown element,

        Args:
            markdown (Markdown): The parent Markdown object.
            token (Any): A token from markdown-it.

        Returns:
            MarkdownElement: A new markdown element
        """
        return cls(str(token.attrs.get("src", "")), markdown.hyperlinks)

    def __init__(self, destination: str, hyperlinks: bool) -> None:
        self.destination = destination
        self.hyperlinks = hyperlinks
        self.link: str | None = None
        super().__init__()

    def on_enter(self, context: MarkdownContext) -> None:
        self.link = context.current_style.link
        self.text = Text(justify="left")
        super().on_enter(context)

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        link_style = Style(link=self.link or self.destination or None)
        title = self.text or Text(self.destination.strip("/").rsplit("/", 1)[-1])
        if self.hyperlinks:
            title.stylize(link_style)
        text = Text.assemble("🌆 ", title, " ", end="")
        yield text


class MarkdownContext:
    """Manages the console render state."""

    def __init__(
        self,
        console: Console,
        options: ConsoleOptions,
        style: Style,
        fallback_styles: Mapping[str, Style],
        inline_code_lexer: str | None = None,
        inline_code_theme: str | SyntaxTheme = _KIMI_ANSI_THEME_NAME,
    ) -> None:
        self.console = console
        self.options = options
        self.style_stack: StyleStack = StyleStack(style)
        self.stack: Stack[MarkdownElement] = Stack()
        self._fallback_styles = fallback_styles

        self._syntax: Syntax | None = None
        if inline_code_lexer is not None:
            self._syntax = Syntax("", inline_code_lexer, theme=inline_code_theme)

    @property
    def current_style(self) -> Style:
        """Current style which is the product of all styles on the stack."""
        return self.style_stack.current

    def on_text(self, text: str, node_type: str) -> None:
        """Called when the parser visits text."""
        if node_type in {"fence", "code_inline"} and self._syntax is not None:
            highlighted = self._syntax.highlight(text)
            highlighted.rstrip()
            stripped = _strip_background(highlighted)
            combined = Text.assemble(stripped, style=self.style_stack.current)
            self.stack.top.on_text(self, combined)
        else:
            self.stack.top.on_text(self, text)

    def enter_style(self, style_name: str | Style) -> Style:
        """Enter a style context."""
        if isinstance(style_name, Style):
            style = style_name
        else:
            fallback = self._fallback_styles.get(style_name, Style())
            style = self.console.get_style(style_name, default=fallback)
            style = fallback + style
        style = style.copy()
        if isinstance(style_name, str) and style_name == "markdown.block_quote":
            style = style.without_color
        if (
            isinstance(style_name, str)
            and style_name in {"markdown.code", "markdown.code_block"}
            and style._bgcolor is not None
        ):
            style._bgcolor = None
        self.style_stack.push(style)
        return self.current_style

    def leave_style(self) -> Style:
        """Leave a style context."""
        style = self.style_stack.pop()
        return style


class Markdown(JupyterMixin):
    """A Markdown renderable.

    Args:
        markup (str): A string containing markdown.
        code_theme (str, optional): Pygments theme for code blocks. Defaults to "kimi-ansi".
            See https://pygments.org/styles/ for code themes.
        justify (JustifyMethod, optional): Justify value for paragraphs. Defaults to None.
        style (Union[str, Style], optional): Optional style to apply to markdown.
        hyperlinks (bool, optional): Enable hyperlinks. Defaults to ``True``.
        inline_code_lexer: (str, optional): Lexer to use if inline code highlighting is
            enabled. Defaults to None.
        inline_code_theme: (Optional[str], optional): Pygments theme for inline code
            highlighting, or None for no highlighting. Defaults to None.
    """

    elements: ClassVar[dict[str, type[MarkdownElement]]] = {
        "paragraph_open": Paragraph,
        "heading_open": Heading,
        "fence": CodeBlock,
        "code_block": CodeBlock,
        "blockquote_open": BlockQuote,
        "hr": HorizontalRule,
        "bullet_list_open": ListElement,
        "ordered_list_open": ListElement,
        "list_item_open": ListItem,
        "image": ImageItem,
        "table_open": TableElement,
        "tbody_open": TableBodyElement,
        "thead_open": TableHeaderElement,
        "tr_open": TableRowElement,
        "td_open": TableDataElement,
        "th_open": TableDataElement,
    }

    inlines = {"em", "strong", "code", "s"}

    def __init__(
        self,
        markup: str,
        code_theme: str = _KIMI_ANSI_THEME_NAME,
        justify: JustifyMethod | None = None,
        style: str | Style = "none",
        hyperlinks: bool = True,
        inline_code_lexer: str | None = None,
        inline_code_theme: str | None = None,
    ) -> None:
        parser = MarkdownIt().enable("strikethrough").enable("table")
        self.markup = markup
        self.parsed = parser.parse(markup)
        self.code_theme = _resolve_code_theme(code_theme)
        self.justify: JustifyMethod | None = justify
        self.style = style
        self.hyperlinks = hyperlinks
        self.inline_code_lexer = inline_code_lexer
        self.inline_code_theme = _resolve_code_theme(inline_code_theme or code_theme)

    def _flatten_tokens(self, tokens: Iterable[Token]) -> Iterable[Token]:
        """Flattens the token stream."""
        for token in tokens:
            is_fence = token.type == "fence"
            is_image = token.tag == "img"
            if token.children and not (is_image or is_fence):
                yield from self._flatten_tokens(token.children)
            else:
                yield token

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        """Render markdown to the console."""
        style = console.get_style(self.style, default="none")
        options = options.update(height=None)
        context = MarkdownContext(
            console,
            options,
            style,
            _FALLBACK_STYLES,
            inline_code_lexer=self.inline_code_lexer,
            inline_code_theme=self.inline_code_theme,
        )
        tokens = self.parsed
        inline_style_tags = self.inlines
        new_line = False
        _new_line_segment = Segment.line()
        render_started = False

        for token in self._flatten_tokens(tokens):
            node_type = token.type
            tag = token.tag

            entering = token.nesting == 1
            exiting = token.nesting == -1
            self_closing = token.nesting == 0

            if node_type in {"text", "html_inline", "html_block"}:
                # Render HTML tokens as plain text so safeword markup stays visible.
                context.on_text(token.content, node_type)
            elif node_type == "hardbreak":
                context.on_text("\n", node_type)
            elif node_type == "softbreak":
                context.on_text(" ", node_type)
            elif node_type == "link_open":
                href = str(token.attrs.get("href", ""))
                if self.hyperlinks:
                    link_style = console.get_style("markdown.link_url", default="none")
                    link_style += Style(link=href)
                    context.enter_style(link_style)
                else:
                    context.stack.push(Link.create(self, token))
            elif node_type == "link_close":
                if self.hyperlinks:
                    context.leave_style()
                else:
                    element = context.stack.pop()
                    assert isinstance(element, Link)
                    link_style = console.get_style("markdown.link", default="none")
                    context.enter_style(link_style)
                    context.on_text(element.text.plain, node_type)
                    context.leave_style()
                    context.on_text(" (", node_type)
                    link_url_style = console.get_style("markdown.link_url", default="none")
                    context.enter_style(link_url_style)
                    context.on_text(element.href, node_type)
                    context.leave_style()
                    context.on_text(")", node_type)
            elif tag in inline_style_tags and node_type != "fence" and node_type != "code_block":
                if entering:
                    # If it's an opening inline token e.g. strong, em, etc.
                    # Then we move into a style context i.e. push to stack.
                    context.enter_style(f"markdown.{tag}")
                elif exiting:
                    # If it's a closing inline style, then we pop the style
                    # off of the stack, to move out of the context of it...
                    context.leave_style()
                else:
                    # If it's a self-closing inline style e.g. `code_inline`
                    context.enter_style(f"markdown.{tag}")
                    if token.content:
                        context.on_text(token.content, node_type)
                    context.leave_style()
            else:
                # Map the markdown tag -> MarkdownElement renderable
                element_class = self.elements.get(token.type) or UnknownElement
                element = element_class.create(self, token)

                if entering or self_closing:
                    context.stack.push(element)
                    element.on_enter(context)

                if exiting:  # CLOSING tag
                    element = context.stack.pop()

                    should_render = not context.stack or (
                        context.stack and context.stack.top.on_child_close(context, element)
                    )

                    if should_render:
                        if new_line and render_started:
                            yield _new_line_segment

                        rendered = console.render(element, context.options)
                        for segment in rendered:
                            render_started = True
                            yield segment
                elif self_closing:  # SELF-CLOSING tags (e.g. text, code, image)
                    context.stack.pop()
                    text = token.content
                    if text is not None:
                        element.on_text(context, text)

                    should_render = (
                        not context.stack
                        or context.stack
                        and context.stack.top.on_child_close(context, element)
                    )
                    if should_render:
                        if new_line and node_type != "inline" and render_started:
                            yield _new_line_segment
                        rendered = console.render(element, context.options)
                        for segment in rendered:
                            render_started = True
                            yield segment

                if exiting or self_closing:
                    element.on_leave(context)
                    new_line = element.new_line


if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Render Markdown to the console with Rich")
    parser.add_argument(
        "path",
        metavar="PATH",
        help="path to markdown file, or - for stdin",
    )
    parser.add_argument(
        "-c",
        "--force-color",
        dest="force_color",
        action="store_true",
        default=None,
        help="force color for non-terminals",
    )
    parser.add_argument(
        "-t",
        "--code-theme",
        dest="code_theme",
        default=_KIMI_ANSI_THEME_NAME,
        help='code theme (pygments name or "kimi-ansi")',
    )
    parser.add_argument(
        "-i",
        "--inline-code-lexer",
        dest="inline_code_lexer",
        default=None,
        help="inline_code_lexer",
    )
    parser.add_argument(
        "-y",
        "--hyperlinks",
        dest="hyperlinks",
        action="store_true",
        help="enable hyperlinks",
    )
    parser.add_argument(
        "-w",
        "--width",
        type=int,
        dest="width",
        default=None,
        help="width of output (default will auto-detect)",
    )
    parser.add_argument(
        "-j",
        "--justify",
        dest="justify",
        action="store_true",
        help="enable full text justify",
    )
    parser.add_argument(
        "-p",
        "--page",
        dest="page",
        action="store_true",
        help="use pager to scroll output",
    )
    args = parser.parse_args()

    from rich.console import Console

    if args.path == "-":
        markdown_body = sys.stdin.read()
    else:
        with open(args.path, encoding="utf-8") as markdown_file:
            markdown_body = markdown_file.read()

    markdown = Markdown(
        markdown_body,
        justify="full" if args.justify else "left",
        code_theme=args.code_theme,
        hyperlinks=args.hyperlinks,
        inline_code_lexer=args.inline_code_lexer,
    )
    if args.page:
        import io
        import pydoc

        fileio = io.StringIO()
        console = Console(file=fileio, force_terminal=args.force_color, width=args.width)
        console.print(markdown)
        pydoc.pager(fileio.getvalue())

    else:
        console = Console(force_terminal=args.force_color, width=args.width, record=True)
        console.print(markdown)

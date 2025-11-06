from rich.console import Console, ConsoleOptions, RenderResult
from rich.markdown import Heading, Markdown
from rich.panel import Panel
from rich.table import box
from rich.text import Text


class _LeftAlignedHeading(Heading):
    """Heading element with left-aligned content."""

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        text = self.text
        text.justify = "left"
        if self.tag == "h2":
            text.stylize("bold")
        if self.tag == "h1":
            yield Panel(text, box=box.HEAVY, style="markdown.h1.border")
        else:
            if self.tag == "h2":
                yield Text("")
            yield text


class CustomMarkdown(Markdown):
    """Markdown renderer that left-aligns headings."""

    elements = dict(Markdown.elements)
    elements["heading_open"] = _LeftAlignedHeading

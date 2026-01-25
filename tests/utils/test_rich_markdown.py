from rich.console import Console

from kimi_cli.utils.rich.markdown import Markdown


def test_markdown_html_block_renders_without_stack_error() -> None:
    console = Console(width=80, record=True)
    markdown = Markdown("<analysis>\nHello\n</analysis>\n")
    segments = list(console.render(markdown))
    rendered = "".join(segment.text for segment in segments)
    assert "<analysis>" in rendered

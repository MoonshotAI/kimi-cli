from rich.console import Console
from rich.text import Text

from kimi_cli.utils.rich.columns import BulletColumns
from kimi_cli.utils.rich.markdown import Markdown


def test_markdown_html_block_renders_without_stack_error() -> None:
    console = Console(width=80, record=True)
    markdown = Markdown("<analysis>\nHello\n</analysis>\n")
    segments = list(console.render(markdown))
    rendered = "".join(segment.text for segment in segments)
    assert "<analysis>" in rendered


def _normalize_text(text: str) -> str:
    return " ".join(text.replace("•", " ").split())


def test_markdown_list_wrapping_preserves_text() -> None:
    console = Console(width=60, record=True)
    markdown = Markdown(
        "- **What it does:** Acts as an autonomous agent that can write code, run shell commands, edit files, browse the web, and manage multi-step tasks through an interactive chat interface\n"
        "- **Architecture:** Built around a core agent loop (KimiSoul) that orchestrates LLM calls, tool execution, context management, and conversation compaction\n"
    )

    console.print(markdown)
    rendered = _normalize_text(console.export_text())

    assert "run shell commands, edit files, browse the web" in rendered
    assert "core agent loop (KimiSoul)" in rendered


def test_markdown_list_wrapping_preserves_text_inside_outer_bullet() -> None:
    console = Console(width=60, record=True)
    markdown = Markdown(
        "- **What it does:** Acts as an autonomous agent that can write code, run shell commands, edit files, browse the web, and manage multi-step tasks through an interactive chat interface\n"
        "- **Architecture:** Built around a core agent loop (KimiSoul) that orchestrates LLM calls, tool execution, context management, and conversation compaction\n"
    )

    console.print(BulletColumns(markdown, bullet=Text("•")))
    rendered = _normalize_text(console.export_text())

    assert "run shell commands, edit files, browse the web" in rendered
    assert "core agent loop (KimiSoul)" in rendered


def test_markdown_list_wrapping_preserves_inline_styling() -> None:
    console = Console(width=80, record=True, force_terminal=True)
    markdown = Markdown(
        "- **What it does:** Acts as an autonomous agent that can write code, run shell commands, edit files, browse the web, and manage multi-step tasks through an interactive chat interface\n"
    )

    console.print(markdown)
    rendered = console.export_text(styles=True)

    assert "\x1b[1mWhat it does:\x1b[0m" in rendered


def test_markdown_list_wrapping_preserves_word_boundaries() -> None:
    console = Console(width=80, record=True)
    markdown = Markdown(
        "- **What it does:** Acts as an autonomous agent that can write code, run shell commands, edit files, browse the web, and manage multi-step tasks through an interactive chat interface\n"
    )

    console.print(markdown)

    assert console.export_text() == (
        "• What it does: Acts as an autonomous agent that can write code, run shell\n"
        "  commands, edit files, browse the web, and manage multi-step tasks through an\n"
        "  interactive chat interface\n"
    )


def test_markdown_list_hard_break_preserves_continuation_line() -> None:
    console = Console(width=60, record=True)
    markdown = Markdown("- first\\\n  second\n")

    console.print(markdown)

    assert console.export_text() == "• first\n  second\n"


def test_markdown_list_soft_break_collapses_to_space() -> None:
    console = Console(width=60, record=True)
    markdown = Markdown("- first\n  second\n")

    console.print(markdown)

    assert console.export_text() == "• first second\n"


def test_markdown_list_long_unspaced_content_keeps_continuation_indent() -> None:
    console = Console(width=30, record=True)
    markdown = Markdown("- /very/long/path/without/any/spaces/that/should/not/reset/indentation\n")

    console.print(markdown)
    lines = console.export_text().splitlines()

    assert lines[0].startswith("• ")
    assert len(lines) > 1
    assert all(line.startswith("  ") for line in lines[1:])


def test_markdown_nested_list_keeps_expected_indent() -> None:
    console = Console(width=40, record=True)
    markdown = Markdown("- a\n  - b\n")

    console.print(markdown)

    assert console.export_text() == "• a\n  • b\n"


def test_markdown_wrapped_nested_list_does_not_add_parent_indent() -> None:
    console = Console(width=30, record=True)
    markdown = Markdown(
        "- parent long text that wraps around in width\n"
        "  - child long text also wraps around width\n"
    )

    console.print(markdown)

    assert console.export_text() == (
        "• parent long text that wraps\n"
        "  around in width\n"
        "  • child long text also\n"
        "    wraps around width\n"
    )

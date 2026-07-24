"""Tests for NEUTRAL_MARKDOWN_THEME style overrides."""

from __future__ import annotations

from kimi_cli.ui.shell.console import NEUTRAL_MARKDOWN_THEME


class TestNeutralMarkdownThemeNoBgColor:
    """markdown.code and markdown.code_block must not inherit Rich's default
    black background (``"cyan on black"`` / ``"bold cyan on black"``).

    Rich's built-in default theme defines::

        "markdown.code":       "bold cyan on black"
        "markdown.code_block": "cyan on black"

    Because NEUTRAL_MARKDOWN_THEME uses ``inherit=True``, any style key NOT
    explicitly listed inherits the Rich default.  If we forget to override
    ``markdown.code`` and ``markdown.code_block``, inline code and fenced code
    blocks will render with an opaque black background that looks wrong on
    non-black terminals (the "black code block" bug, see issue #1681).
    """

    def test_markdown_code_has_no_background(self) -> None:
        style = NEUTRAL_MARKDOWN_THEME.styles.get("markdown.code")
        assert style is not None, "markdown.code must be explicitly set in NEUTRAL_MARKDOWN_THEME"
        assert style.bgcolor is None, (
            f"markdown.code should have no background color, got bgcolor={style.bgcolor}"
        )

    def test_markdown_code_block_has_no_background(self) -> None:
        style = NEUTRAL_MARKDOWN_THEME.styles.get("markdown.code_block")
        assert style is not None, (
            "markdown.code_block must be explicitly set in NEUTRAL_MARKDOWN_THEME"
        )
        assert style.bgcolor is None, (
            f"markdown.code_block should have no background color, got bgcolor={style.bgcolor}"
        )

    def test_all_markdown_styles_have_no_background(self) -> None:
        """No markdown.* style in NEUTRAL_MARKDOWN_THEME should carry a background color.

        Rich's default theme may assign background colors to markdown styles
        (e.g. ``"cyan on black"`` for code).  Since NEUTRAL_MARKDOWN_THEME uses
        ``inherit=True``, any key we forget to override will inherit the Rich
        default.  This test catches that for ALL markdown styles, not just the
        ones we know about today.
        """
        for name, style in NEUTRAL_MARKDOWN_THEME.styles.items():
            if name.startswith("markdown."):
                assert style.bgcolor is None, (
                    f"{name} should have no background color, got bgcolor={style.bgcolor}"
                )

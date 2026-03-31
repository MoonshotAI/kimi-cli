from __future__ import annotations

from rich.console import Group
from rich.style import Style
from rich.text import Text

from kimi_cli.ui.shell.console import _OSC8_RE, render_to_ansi


class TestOSC8Regex:
    """Unit tests for the _OSC8_RE pattern itself."""

    def test_matches_st_terminator(self):
        """Match OSC 8 sequence terminated with ESC \\ (ST)."""
        seq = "\x1b]8;id=123;https://example.com\x1b\\"
        assert _OSC8_RE.fullmatch(seq)

    def test_matches_bel_terminator(self):
        """Match OSC 8 sequence terminated with BEL (\\x07)."""
        seq = "\x1b]8;id=123;https://example.com\x07"
        assert _OSC8_RE.fullmatch(seq)

    def test_matches_close_marker(self):
        """Match the closing OSC 8 marker (empty params and URI)."""
        seq = "\x1b]8;;\x1b\\"
        assert _OSC8_RE.fullmatch(seq)

    def test_does_not_match_csi_sequences(self):
        """Must not match regular CSI (ESC [) ANSI sequences."""
        csi = "\x1b[31m"
        assert _OSC8_RE.search(csi) is None

    def test_strips_only_markers_preserves_text(self):
        """Substitution should remove markers but keep visible text between them."""
        raw = "\x1b]8;id=99;https://x.com\x1b\\hello\x1b]8;;\x1b\\"
        assert _OSC8_RE.sub("", raw) == "hello"

    def test_strips_multiple_links(self):
        raw = (
            "\x1b]8;id=1;https://a.com\x1b\\A\x1b]8;;\x1b\\"
            " "
            "\x1b]8;id=2;https://b.com\x1b\\B\x1b]8;;\x1b\\"
        )
        assert _OSC8_RE.sub("", raw) == "A B"

    def test_no_false_positive_on_plain_text(self):
        assert _OSC8_RE.search("hello 8;id=123;https://x.com world") is None


class TestRenderToAnsiStripsOSC8:
    """Verify that OSC 8 hyperlink sequences are stripped in render_to_ansi.

    prompt_toolkit's ANSI parser does not understand OSC 8, so raw escape
    sequences leak through as visible text (e.g. ``8;id=391551;https://…``).
    render_to_ansi must strip the control markers while preserving the
    visible link text.
    """

    def test_link_text_preserved_but_osc8_stripped(self):
        """Text with a Style(link=...) should keep the visible text but drop OSC 8 markers."""
        text = Text()
        text.append("click ", style="grey50")
        text.append("here", style=Style(color="grey50", link="https://example.com"))
        result = render_to_ansi(text, columns=80)
        # The word "here" must still be present
        assert "here" in result
        # OSC 8 escape sequences must NOT appear
        assert "\x1b]8;" not in result
        # The raw "id=" fragment that prompt_toolkit would show must not appear
        assert "8;id=" not in result

    def test_plain_text_unaffected(self):
        """Text without links should pass through unchanged."""
        text = Text("hello world", style="green")
        result = render_to_ansi(text, columns=80)
        assert "hello world" in result
        assert "\x1b]8;" not in result

    def test_multiple_links_all_stripped(self):
        """Multiple links in one renderable should all be stripped."""
        text = Text()
        text.append("link1", style=Style(link="https://a.com"))
        text.append(" ")
        text.append("link2", style=Style(link="https://b.com"))
        result = render_to_ansi(text, columns=80)
        assert "link1" in result
        assert "link2" in result
        assert "\x1b]8;" not in result

    def test_osc8_with_bel_terminator_stripped(self):
        """OSC 8 sequences terminated with BEL (\\x07) should also be stripped."""
        text = Text()
        text.append("link", style=Style(link="https://example.com"))
        result = render_to_ansi(text, columns=80)
        # Regardless of which terminator Rich uses, no OSC 8 should remain
        assert "\x1b]8;" not in result
        assert "link" in result

    def test_color_ansi_codes_preserved(self):
        """Regular ANSI color codes must survive the stripping."""
        text = Text()
        text.append("colored", style="bold red")
        text.append(" linked", style=Style(color="blue", link="https://x.com"))
        result = render_to_ansi(text, columns=80)
        assert "colored" in result
        assert "linked" in result
        # CSI color codes should still be present
        assert "\x1b[" in result
        # OSC 8 should not
        assert "\x1b]8;" not in result

    def test_fetchurl_style_headline(self):
        """Simulate the exact pattern used by _ToolCallBlock._build_headline_text."""
        url = "https://raw.githubusercontent.com/user/repo/main/README.md"
        text = Text()
        text.append("Using ")
        text.append("FetchURL", style="blue")
        text.append(" (", style="grey50")
        arg_style = Style(color="grey50", link=url)
        text.append("raw.githubusercontent.com/user/repo/…/README.md", style=arg_style)
        text.append(")", style="grey50")
        result = render_to_ansi(text, columns=120)
        assert "FetchURL" in result
        assert "README.md" in result
        assert "\x1b]8;" not in result
        assert "8;id=" not in result

    def test_nested_group_with_links(self):
        """Links inside a Rich Group should also be stripped."""
        t1 = Text("A", style=Style(link="https://a.com"))
        t2 = Text("B", style=Style(link="https://b.com"))
        group = Group(t1, t2)
        result = render_to_ansi(group, columns=80)
        assert "A" in result
        assert "B" in result
        assert "\x1b]8;" not in result

    def test_output_deterministic_across_calls(self):
        """Same renderable should produce identical output — no random link IDs leaking."""
        text = Text("stable", style=Style(link="https://example.com"))
        r1 = render_to_ansi(text, columns=80)
        r2 = render_to_ansi(text, columns=80)
        # After stripping OSC 8, output should be stable (no random link_id diffs)
        assert r1 == r2

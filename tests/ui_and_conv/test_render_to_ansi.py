from __future__ import annotations

import re

import pytest
from prompt_toolkit.formatted_text import ANSI, to_formatted_text
from rich.console import Group
from rich.style import Style
from rich.text import Text

from kimi_cli.ui.shell.console import _OSC8_RE, render_to_ansi

# SGR 48;2;R;G;B — truecolor background escape sequence
_TRUECOLOR_BG_RE = re.compile(r"\x1b\[(?:\d+;)*48;2;\d+;\d+;\d+m")


def _visible_text(ansi_str: str) -> str:
    """Parse an ANSI string through prompt_toolkit and return only visible text.

    ZeroWidthEscape fragments are excluded — they are passed through to the
    terminal via write_raw and never shown to the user.
    """
    fragments = to_formatted_text(ANSI(ansi_str))
    return "".join(text for style, text, *_ in fragments if "[ZeroWidthEscape]" not in style)


def _has_zero_width_osc8(ansi_str: str) -> bool:
    """Return True if the ANSI string contains OSC 8 sequences wrapped as ZeroWidthEscape."""
    fragments = to_formatted_text(ANSI(ansi_str))
    return any("[ZeroWidthEscape]" in style and "\x1b]8;" in text for style, text, *_ in fragments)


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


class TestRenderToAnsiOSC8Integration:
    """Verify that OSC 8 hyperlink sequences are wrapped as ZeroWidthEscape.

    prompt_toolkit's ANSI parser does not understand OSC 8, so bare sequences
    leak through as visible garbage (e.g. ``8;id=391551;https://…``).
    render_to_ansi must wrap OSC 8 markers in \\001…\\002 so prompt_toolkit
    treats them as ZeroWidthEscape and passes them to the terminal via
    write_raw, preserving clickable links for capable terminals.
    """

    @pytest.fixture(autouse=True)
    def _ensure_color(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Ensure Rich produces colored ANSI output even on CI (TERM=dumb).

        Rich checks ``is_dumb_terminal`` (TERM in {dumb, unknown}) before
        reading COLORTERM, so both must be set for reliable detection.
        """
        monkeypatch.setenv("TERM", "xterm-256color")
        monkeypatch.setenv("COLORTERM", "truecolor")

    def test_link_text_visible_osc8_hidden(self):
        """Visible text preserved; OSC 8 markers not rendered as visible characters."""
        text = Text()
        text.append("click ", style="grey50")
        text.append("here", style=Style(color="grey50", link="https://example.com"))
        result = render_to_ansi(text, columns=80)
        visible = _visible_text(result)
        assert "here" in visible
        # No raw OSC 8 fragments in visible output
        assert "8;id=" not in visible
        assert "https://example.com" not in visible

    def test_osc8_preserved_as_zero_width(self):
        """OSC 8 sequences should exist in the output as ZeroWidthEscape, not stripped."""
        text = Text("link", style=Style(link="https://example.com"))
        result = render_to_ansi(text, columns=80)
        assert _has_zero_width_osc8(result)

    def test_plain_text_unaffected(self):
        """Text without links should pass through without ZeroWidthEscape."""
        text = Text("hello world", style="green")
        result = render_to_ansi(text, columns=80)
        visible = _visible_text(result)
        assert "hello world" in visible
        assert not _has_zero_width_osc8(result)

    def test_multiple_links_all_wrapped(self):
        """Multiple links should all be wrapped as ZeroWidthEscape."""
        text = Text()
        text.append("link1", style=Style(link="https://a.com"))
        text.append(" ")
        text.append("link2", style=Style(link="https://b.com"))
        result = render_to_ansi(text, columns=80)
        visible = _visible_text(result)
        assert "link1" in visible
        assert "link2" in visible
        assert "8;id=" not in visible
        # Both links should be present as ZeroWidthEscape
        fragments = to_formatted_text(ANSI(result))
        osc8_fragments = [
            t for s, t, *_ in fragments if "[ZeroWidthEscape]" in s and "\x1b]8;" in t
        ]
        assert len(osc8_fragments) >= 4  # open + close for each link

    def test_color_ansi_codes_preserved(self):
        """Regular ANSI color codes must survive alongside wrapped OSC 8."""
        text = Text()
        text.append("colored", style="bold red")
        text.append(" linked", style=Style(color="blue", link="https://x.com"))
        result = render_to_ansi(text, columns=80)
        visible = _visible_text(result)
        assert "colored" in visible
        assert "linked" in visible
        # CSI color codes should still be present in raw output
        assert "\x1b[" in result

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
        visible = _visible_text(result)
        assert "FetchURL" in visible
        assert "README.md" in visible
        assert "8;id=" not in visible
        # Link should be preserved as ZeroWidthEscape
        assert _has_zero_width_osc8(result)

    def test_nested_group_with_links(self):
        """Links inside a Rich Group should also be wrapped."""
        t1 = Text("A", style=Style(link="https://a.com"))
        t2 = Text("B", style=Style(link="https://b.com"))
        group = Group(t1, t2)
        result = render_to_ansi(group, columns=80)
        visible = _visible_text(result)
        assert "A" in visible
        assert "B" in visible
        assert "8;id=" not in visible
        assert _has_zero_width_osc8(result)

    def test_output_deterministic_across_calls(self):
        """Visible text should be stable across calls — no random link IDs leaking."""
        text = Text("stable", style=Style(link="https://example.com"))
        r1 = _visible_text(render_to_ansi(text, columns=80))
        r2 = _visible_text(render_to_ansi(text, columns=80))
        assert r1 == r2
        assert "stable" in r1
        assert "8;id=" not in r1


class TestRenderToAnsiColorSystem:
    """render_to_ansi must respect the terminal's color capability.

    The two tests deliberately use **different** bgcolor values so that Rich's
    internal LRU caches (``Color.parse``, ``Color.downgrade``, ``Style._add``)
    never share entries between them — no private cache clearing needed.
    """

    def test_no_truecolor_when_terminal_lacks_support(self, monkeypatch: pytest.MonkeyPatch):
        """When COLORTERM is unset and TERM=xterm-256color, output must not
        contain truecolor (SGR 48;2;R;G;B) sequences — they cause rendering
        corruption on terminals that don't support 24-bit color."""
        monkeypatch.delenv("COLORTERM", raising=False)
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setenv("TERM", "xterm-256color")

        text = Text("hello", style=Style(bgcolor="#2d1214"))
        result = render_to_ansi(text, columns=80)

        assert _visible_text(result).strip() == "hello"
        assert not _TRUECOLOR_BG_RE.search(result), (
            "render_to_ansi emitted truecolor SGR on a 256-color terminal"
        )

    def test_truecolor_when_terminal_supports_it(self, monkeypatch: pytest.MonkeyPatch):
        """When COLORTERM=truecolor, 24-bit color sequences are acceptable."""
        monkeypatch.setenv("TERM", "xterm-256color")
        monkeypatch.setenv("COLORTERM", "truecolor")
        monkeypatch.delenv("NO_COLOR", raising=False)

        text = Text("hello", style=Style(bgcolor="#123456"))
        result = render_to_ansi(text, columns=80)

        assert _visible_text(result).strip() == "hello"
        assert _TRUECOLOR_BG_RE.search(result), (
            "render_to_ansi should emit truecolor SGR when terminal supports it"
        )

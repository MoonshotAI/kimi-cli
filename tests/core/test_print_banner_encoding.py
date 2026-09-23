"""print_banner must not raise on consoles whose codec lacks banner glyphs.

The banner is printed before the web/vis server binds its port, so an
unhandled UnicodeEncodeError there kills the process and the server never
starts.
"""

from __future__ import annotations

import contextlib
import io

from kimi_cli.utils.server import print_banner

# U+279C is what web/app.py and vis/app.py put in front of each URL.
_BANNER_LINE = "<nowrap>  ➜  Local    http://127.0.0.1:8000"


def _render(encoding: str) -> str:
    """Render the banner to a stream using the given console encoding."""
    stream = io.TextIOWrapper(io.BytesIO(), encoding=encoding, errors="strict", newline="")
    with contextlib.redirect_stdout(stream):
        print_banner([_BANNER_LINE])
    stream.flush()
    return stream.buffer.getvalue().decode(encoding)  # type: ignore[attr-defined]


def test_print_banner_survives_unencodable_glyph() -> None:
    # gbk is the Chinese-locale Windows console codec and cannot encode U+279C.
    assert "http://127.0.0.1:8000" in _render("gbk")


def test_print_banner_box_stays_aligned() -> None:
    lines = [line for line in _render("gbk").splitlines() if line]
    assert len({len(line) for line in lines}) == 1, lines


def test_print_banner_keeps_glyph_when_encoding_supports_it() -> None:
    assert "➜" in _render("utf-8")

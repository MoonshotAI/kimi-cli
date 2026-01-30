"""Tests for string utility functions."""

from __future__ import annotations

import unicodedata

import pytest

from kimi_cli.utils.string import sanitize_http_header_value

# These examples are intentionally explicit for posterity: NFKD is used to decompose
# compatibility characters (e.g. ① -> 1), then we derive an ASCII-safe header value.
#
# Here’s what that looks like in our exact situation and a few related examples:
#
# - andrewlouis@🏢
#     - NFKD: andrewlouis@🏢 (emoji doesn’t decompose)
#     - ASCII fallback with ignore: andrewlouis@ (emoji dropped)
#     - ASCII fallback with replace: andrewlouis@? (emoji becomes ?)
# - 🏢
#     - NFKD: 🏢
#     - ascii(ignore): `` (empty)
#     - ascii(replace): ?
# - José
#     - NFKD: José (that last “é” becomes e + a combining accent)
#     - ascii(ignore): Jose (accent dropped)
#     - ascii(replace): Jose?
# - München
#     - NFKD: München (ü → u + combining diaeresis)
#     - ascii(ignore): Munchen
# - ①②③
#     - NFKD: 123 (circled numbers become plain digits)


@pytest.mark.parametrize(
    ("raw", "expected_replace"),
    [
        ("andrewlouis@🏢", "andrewlouis@?"),
        ("🏢", "?"),
        ("José", "Jose?"),
        ("München", "Mu?nchen"),
        ("①②③", "123"),
    ],
)
def test_sanitize_http_header_value_replace_examples(raw: str, expected_replace: str) -> None:
    assert sanitize_http_header_value(raw, default="device") == expected_replace
    sanitize_http_header_value(raw, default="device").encode("ascii")


@pytest.mark.parametrize(
    ("raw", "expected_ignore"),
    [
        ("andrewlouis@🏢", "andrewlouis@"),
        ("🏢", ""),
        ("José", "Jose"),
        ("München", "Munchen"),
        ("①②③", "123"),
    ],
)
def test_nfkd_ascii_ignore_examples(raw: str, expected_ignore: str) -> None:
    nfkd = unicodedata.normalize("NFKD", raw)
    assert nfkd.encode("ascii", errors="ignore").decode("ascii") == expected_ignore


def test_sanitize_http_header_value_strips_controls_and_newlines() -> None:
    # Separate from the Unicode/NFKD examples: this is about header injection
    # hardening and output stability. We intentionally collapse whitespace so
    # "\r\n" (turned into two spaces) becomes a single space.
    raw = "hi\r\nevil: 1\x00"
    assert sanitize_http_header_value(raw, default="device") == "hi evil: 1"


def test_sanitize_http_header_value_collapses_internal_whitespace() -> None:
    raw = "a\t\tb   c"
    assert sanitize_http_header_value(raw, default="device") == "a b c"


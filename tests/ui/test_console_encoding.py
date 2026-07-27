"""Tests for UTF-8 enforcement on the standard streams.

The welcome banner and status messages use box-drawing and symbol characters
such as ``▐`` (U+2590) and ``✓`` (U+2713).  On Windows the standard streams
default to the system locale encoding (e.g. GBK/cp936), which cannot represent
them, so the first write raised ``UnicodeEncodeError`` and killed the CLI before
it started (see issue #1436).
"""

from __future__ import annotations

import io

import pytest

from kimi_cli.ui.shell.console import _ensure_utf8_stdio

LOGO = "▐█▛█▛█▌"
CHECKMARK = "✓"


class _FakeStream:
    """Minimal stand-in for a text stream that records reconfigure() calls."""

    def __init__(self, encoding: str, *, error: Exception | None = None) -> None:
        self.encoding = encoding
        self.errors = "strict"
        self._error = error
        self.calls: list[dict[str, str]] = []

    def reconfigure(self, *, encoding: str, errors: str) -> None:
        self.calls.append({"encoding": encoding, "errors": errors})
        if self._error is not None:
            raise self._error
        self.encoding = encoding
        self.errors = errors


class TestEnsureUtf8Stdio:
    def test_reconfigures_stdout_and_stderr_to_utf8(self, monkeypatch: pytest.MonkeyPatch) -> None:
        stdout = _FakeStream("gbk")
        stderr = _FakeStream("gbk")
        monkeypatch.setattr("sys.stdout", stdout)
        monkeypatch.setattr("sys.stderr", stderr)

        _ensure_utf8_stdio()

        for stream in (stdout, stderr):
            assert stream.calls == [{"encoding": "utf-8", "errors": "replace"}]
            assert stream.encoding == "utf-8"

    def test_tolerates_streams_without_reconfigure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Wrapped or replaced streams may not expose reconfigure()."""
        monkeypatch.setattr("sys.stdout", object())
        monkeypatch.setattr("sys.stderr", object())

        _ensure_utf8_stdio()  # must not raise

    @pytest.mark.parametrize("error", [OSError("detached"), ValueError("closed")])
    def test_tolerates_reconfigure_failures(
        self, monkeypatch: pytest.MonkeyPatch, error: Exception
    ) -> None:
        """A stream that refuses reconfiguration must not fail startup."""
        stdout = _FakeStream("gbk", error=error)
        monkeypatch.setattr("sys.stdout", stdout)
        monkeypatch.setattr("sys.stderr", _FakeStream("gbk"))

        _ensure_utf8_stdio()  # must not raise

        assert stdout.calls == [{"encoding": "utf-8", "errors": "replace"}]


class TestBannerGlyphsAreEncodable:
    def test_locale_encoding_would_fail_without_utf8(self) -> None:
        """Guards the premise of the fix: these glyphs are not GBK-encodable."""
        with pytest.raises(UnicodeEncodeError):
            (LOGO + CHECKMARK).encode("gbk")

    def test_utf8_stream_writes_banner_glyphs(self) -> None:
        """After reconfiguration the same glyphs round-trip losslessly."""
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="utf-8", errors="replace")

        stream.write(LOGO + CHECKMARK)
        stream.flush()

        assert raw.getvalue().decode("utf-8") == LOGO + CHECKMARK

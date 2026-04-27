from __future__ import annotations

import io
import os
import sys

import pytest

from kimi_cli.utils import proctitle


@pytest.fixture(autouse=True)
def _reset_cached_handle(monkeypatch: pytest.MonkeyPatch):
    """Reset the module-level cache so each test sees a clean slate."""
    monkeypatch.setattr(proctitle, "_original_stderr_handle", None)


def test_truncate_topic_collapses_whitespace():
    assert proctitle._truncate_topic("hello   world\n  again") == "hello world again"


def test_truncate_topic_clamps_long_input():
    out = proctitle._truncate_topic("x" * 200, max_len=10)
    assert len(out) == 10
    assert out.endswith("\u2026")


def test_truncate_topic_passthrough_when_short():
    assert proctitle._truncate_topic("short", max_len=40) == "short"


def test_compose_terminal_title_base_only():
    assert proctitle.compose_session_terminal_title() == "Kimi Code"


def test_compose_terminal_title_cwd_only():
    title = proctitle.compose_session_terminal_title(work_dir="/home/user/projects/my-project")
    assert title == "Kimi Code \u00b7 my-project"


def test_compose_terminal_title_with_topic_and_cwd():
    title = proctitle.compose_session_terminal_title(
        work_dir="/tmp/proj",
        topic="Refactor auth module to use JWT",
    )
    assert title == "Kimi Code \u00b7 Refactor auth module to use JWT \u00b7 proj"


def test_compose_terminal_title_topic_truncated():
    long_topic = "a" * 100
    title = proctitle.compose_session_terminal_title(work_dir="/x", topic=long_topic)
    # Topic is truncated to 40 chars (39 + ellipsis)
    assert "\u2026" in title
    assert " \u00b7 x" in title


def test_compose_terminal_title_ignores_empty_topic():
    title = proctitle.compose_session_terminal_title(work_dir="/x/proj", topic="")
    assert title == "Kimi Code \u00b7 proj"


def test_compose_terminal_title_normalizes_trailing_separator():
    title = proctitle.compose_session_terminal_title(work_dir="/x/proj/")
    assert title.endswith("proj")


def test_compose_terminal_title_preserves_chinese_characters():
    title = proctitle.compose_session_terminal_title(
        work_dir="C:/项目/我的-app",
        topic="重构鉴权 模块",
    )
    assert "重构鉴权 模块" in title
    assert "我的-app" in title


def test_compose_terminal_title_preserves_emoji():
    title = proctitle.compose_session_terminal_title(
        work_dir="/x/proj",
        topic="🚀 ship release",
    )
    assert "🚀 ship release" in title


class _TTYStringIO(io.StringIO):
    def isatty(self) -> bool:  # type: ignore[override]
        return True


def test_set_terminal_title_emits_osc_when_tty(monkeypatch: pytest.MonkeyPatch):
    fake = _TTYStringIO()
    monkeypatch.setattr(sys, "stderr", fake)
    proctitle.set_terminal_title("hello")
    assert fake.getvalue() == "\033]0;hello\007"


def test_set_terminal_title_noop_when_not_tty(monkeypatch: pytest.MonkeyPatch):
    fake = io.StringIO()  # default isatty() == False
    monkeypatch.setattr(sys, "stderr", fake)
    proctitle.set_terminal_title("nope")
    assert fake.getvalue() == ""


def test_update_terminal_title_for_session_emits_composed_title(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = _TTYStringIO()
    monkeypatch.setattr(sys, "stderr", fake)
    proctitle.update_terminal_title_for_session(
        work_dir="/tmp/proj",
        topic="ship release",
    )
    assert fake.getvalue() == "\033]0;Kimi Code \u00b7 ship release \u00b7 proj\007"


def test_sanitize_osc_payload_strips_c0_c1_and_del():
    raw = "ok\x07\x1b[31mEVIL\x00\x1f\x7f\x80\x9fend"
    assert proctitle._sanitize_osc_payload(raw) == "ok[31mEVILend"


def test_sanitize_osc_payload_preserves_unicode():
    raw = "中文 日本語 🚀 café"
    assert proctitle._sanitize_osc_payload(raw) == raw


def test_set_terminal_title_sanitizes_control_bytes(monkeypatch: pytest.MonkeyPatch):
    fake = _TTYStringIO()
    monkeypatch.setattr(sys, "stderr", fake)
    proctitle.set_terminal_title("evil\x07\x1b]0;hijack\x07tail")
    written = fake.getvalue()
    assert written.startswith("\033]0;")
    assert written.endswith("\007")
    payload = written[len("\033]0;") : -1]
    for forbidden in ("\x1b", "\x07", "\n", "\r", "\t", "\x1f", "\x9f", "\x7f"):
        assert forbidden not in payload, f"control byte {forbidden!r} leaked into payload"
    assert payload == "evil]0;hijacktail"


def test_set_terminal_title_chinese_round_trip_via_osc(monkeypatch: pytest.MonkeyPatch):
    fake = _TTYStringIO()
    monkeypatch.setattr(sys, "stderr", fake)
    title = proctitle.compose_session_terminal_title(
        work_dir="C:/项目/我的-app",
        topic="重构鉴权 模块 to use JWT",
    )
    proctitle.set_terminal_title(title)
    written = fake.getvalue()
    payload = written[len("\033]0;") : -1]
    assert payload == title
    assert "重构鉴权" in payload
    assert "我的-app" in payload


def test_set_terminal_title_emoji_round_trip_via_osc(monkeypatch: pytest.MonkeyPatch):
    fake = _TTYStringIO()
    monkeypatch.setattr(sys, "stderr", fake)
    title = "Kimi Code \u00b7 🚀 ship release \u00b7 proj"
    proctitle.set_terminal_title(title)
    payload = fake.getvalue()[len("\033]0;") : -1]
    assert payload == title
    assert "🚀" in payload


class _TTYBytesIO(io.BytesIO):
    """BytesIO that pretends to wrap a TTY-bound fd via a sentinel fileno."""

    _SENTINEL_FD = 4242

    def fileno(self) -> int:  # type: ignore[override]
        return self._SENTINEL_FD


def test_set_terminal_title_uses_pre_redirect_handle_when_stderr_redirected(
    monkeypatch: pytest.MonkeyPatch,
):
    """After redirect_stderr_to_logger swaps fd 2 for a pipe, sys.stderr.isatty()
    is False but the title must still reach the original terminal via the
    cached pre-redirect handle from utils.logging.get_original_stderr_handle.
    """
    redirected_stderr = io.StringIO()  # default isatty() == False, like the pipe
    monkeypatch.setattr(sys, "stderr", redirected_stderr)

    captured = _TTYBytesIO()
    real_isatty = os.isatty

    def fake_isatty(fd: int) -> bool:
        if fd == _TTYBytesIO._SENTINEL_FD:
            return True
        return real_isatty(fd)

    monkeypatch.setattr(os, "isatty", fake_isatty)
    monkeypatch.setattr(
        "kimi_cli.utils.logging.get_original_stderr_handle",
        lambda: captured,
    )

    proctitle.set_terminal_title("from-redirected")

    # Must NOT have written to the redirected (non-TTY) sys.stderr
    assert redirected_stderr.getvalue() == ""
    # Must have written the OSC payload to the cached original-stderr handle
    assert captured.getvalue() == b"\033]0;from-redirected\007"
    # And the handle must now be cached for subsequent calls
    assert proctitle._original_stderr_handle is captured


def test_set_terminal_title_falls_back_to_stderr_when_redirector_not_installed(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = _TTYStringIO()
    monkeypatch.setattr(sys, "stderr", fake)
    monkeypatch.setattr(
        "kimi_cli.utils.logging.get_original_stderr_handle",
        lambda: None,
    )
    proctitle.set_terminal_title("startup")
    assert fake.getvalue() == "\033]0;startup\007"
    assert proctitle._original_stderr_handle is None


def test_set_terminal_title_noop_when_original_stderr_not_tty(
    monkeypatch: pytest.MonkeyPatch,
):
    """If the user already redirected stderr to a file before launch, the
    pre-redirect fd is not a TTY either; emitting OSC bytes there would
    corrupt the file. We must no-op in that case.
    """
    redirected_stderr = io.StringIO()  # not a TTY
    monkeypatch.setattr(sys, "stderr", redirected_stderr)

    writes: list[bytes] = []

    class _NonTTYHandle:
        closed = False

        def fileno(self) -> int:
            return 4243

        def write(self, data: bytes) -> int:
            writes.append(data)
            return len(data)

        def flush(self) -> None:
            pass

        def close(self) -> None:
            self.closed = True

    handle = _NonTTYHandle()
    real_isatty = os.isatty

    def fake_isatty(fd: int) -> bool:
        if fd == 4243:
            return False
        return real_isatty(fd)

    monkeypatch.setattr(os, "isatty", fake_isatty)
    monkeypatch.setattr(
        "kimi_cli.utils.logging.get_original_stderr_handle",
        lambda: handle,
    )

    proctitle.set_terminal_title("nowhere")

    assert redirected_stderr.getvalue() == ""
    assert writes == []
    assert handle.closed is True
    assert proctitle._original_stderr_handle is None


class _AsciiOnlyTTY(io.StringIO):
    encoding = "ascii"

    def isatty(self) -> bool:  # type: ignore[override]
        return True


def test_set_terminal_title_degrades_on_unencodable_stderr(
    monkeypatch: pytest.MonkeyPatch,
):
    # Force the original-stderr-handle path to miss so the sys.stderr
    # fallback is exercised. The autouse _reset_cached_handle fixture
    # already nulled the cache; we additionally stub the lookup helper
    # to simulate "redirector not yet installed".
    monkeypatch.setattr(
        "kimi_cli.utils.logging.get_original_stderr_handle",
        lambda: None,
    )

    fake = _AsciiOnlyTTY()
    monkeypatch.setattr(sys, "stderr", fake)

    # Chinese characters cannot be encoded in ascii; the fallback must
    # NOT raise UnicodeEncodeError, it should write a best-effort form.
    proctitle.set_terminal_title("hello \u4e2d\u6587")

    out = fake.getvalue()
    assert out.startswith("\033]0;")
    assert out.endswith("\007")
    # Original Chinese chars are replaced with '?', but the surrounding
    # OSC envelope and ASCII text are preserved intact.
    assert "hello" in out
    assert "?" in out


def test_set_terminal_title_degrades_when_stderr_write_raises(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        "kimi_cli.utils.logging.get_original_stderr_handle",
        lambda: None,
    )

    class _BoomTTY(io.StringIO):
        encoding = "utf-8"

        def isatty(self) -> bool:  # type: ignore[override]
            return True

        def write(self, s: str) -> int:  # type: ignore[override]
            raise UnicodeEncodeError("ascii", s, 0, 1, "boom")

    monkeypatch.setattr(sys, "stderr", _BoomTTY())
    # Must not propagate; title updates are best-effort.
    proctitle.set_terminal_title("anything")

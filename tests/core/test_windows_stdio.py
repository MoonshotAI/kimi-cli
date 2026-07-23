from __future__ import annotations

import io
import sys


class _EncodinglessStream:
    encoding = None

    def __init__(self) -> None:
        self.value = ""

    def write(self, value: str) -> int:
        self.value += value
        return len(value)

    def flush(self) -> None:
        pass


def test_windows_stdio_allows_welcome_rendering_with_cp936_streams(monkeypatch) -> None:
    from kimi_cli.__main__ import _ensure_utf8_stdio

    stdout_buffer = io.BytesIO()
    stderr_buffer = io.BytesIO()
    stdout = io.TextIOWrapper(stdout_buffer, encoding="cp936", errors="strict")
    stderr = io.TextIOWrapper(stderr_buffer, encoding="cp936", errors="strict")
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)

    _ensure_utf8_stdio()

    import kimi_cli.ui.shell as shell_ui
    from kimi_cli.ui.shell import _print_welcome_info
    from kimi_cli.ui.shell.console import _KimiConsole

    monkeypatch.setattr(shell_ui, "console", _KimiConsole(file=sys.stdout, highlight=False))
    _print_welcome_info("Kimi Code CLI", [])
    sys.stdout.flush()

    assert sys.stdout.encoding == "utf-8"
    assert "Welcome to Kimi Code CLI!" in stdout_buffer.getvalue().decode("utf-8")


def test_windows_stdio_preserves_redirected_and_encodingless_streams(monkeypatch) -> None:
    from kimi_cli.__main__ import _ensure_utf8_stdio

    redirected = io.StringIO()
    encodingless = _EncodinglessStream()
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "stdout", redirected)
    monkeypatch.setattr(sys, "stderr", encodingless)

    _ensure_utf8_stdio()

    assert sys.stdout is redirected
    assert sys.stderr is encodingless
    print("redirected")
    print("encodingless", file=sys.stderr)
    assert redirected.getvalue() == "redirected\n"
    assert encodingless.value == "encodingless\n"


def test_non_windows_stdio_is_unchanged(monkeypatch) -> None:
    from kimi_cli.__main__ import _ensure_utf8_stdio

    stream = io.TextIOWrapper(io.BytesIO(), encoding="cp936", errors="strict")
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sys, "stdout", stream)

    _ensure_utf8_stdio()

    assert sys.stdout is stream
    assert sys.stdout.encoding == "cp936"

from __future__ import annotations

import io
import sys

import pytest

from kimi_cli.utils import proctitle


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

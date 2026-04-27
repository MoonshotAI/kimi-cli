from __future__ import annotations

import pytest

from kimi_cli.utils import proctitle


def test_short_session_id_strips_dashes_and_truncates():
    sid = "12345678-aaaa-bbbb-cccc-dddddddddddd"
    assert proctitle._short_session_id(sid) == "12345678"


def test_short_session_id_passthrough_when_short():
    assert proctitle._short_session_id("abc") == "abc"


def test_compose_session_process_title_full():
    title = proctitle.compose_session_process_title(
        "12345678-aaaa-bbbb-cccc-dddddddddddd",
        work_dir="/home/user/projects/my-project",
    )
    assert title == "kimi-code session=12345678 cwd=my-project"


def test_compose_session_process_title_without_workdir():
    title = proctitle.compose_session_process_title("12345678-aaaa-bbbb-cccc-dddddddddddd")
    assert title == "kimi-code session=12345678"


def test_compose_session_process_title_custom_base():
    title = proctitle.compose_session_process_title(
        "deadbeefcafebabe", base_name="kimi-code-bg-worker"
    )
    assert title == "kimi-code-bg-worker session=deadbeef"


def test_compose_session_process_title_normalizes_trailing_slash():
    title = proctitle.compose_session_process_title(
        "abcdef0123456789",
        work_dir="/home/user/projects/my-project/",
    )
    # Even with a trailing separator, the basename is still recovered.
    assert "cwd=my-project" in title


def test_set_session_process_title_dispatches_to_setproctitle(monkeypatch: pytest.MonkeyPatch):
    captured: list[str] = []
    monkeypatch.setattr(proctitle, "set_process_title", lambda title: captured.append(title))
    proctitle.set_session_process_title("12345678-aaaa-bbbb-cccc-dddddddddddd", "/tmp/proj")
    assert captured == ["kimi-code session=12345678 cwd=proj"]

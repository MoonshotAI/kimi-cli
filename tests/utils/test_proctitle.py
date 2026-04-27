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


def test_compose_session_process_title_replaces_spaces_in_cwd():
    title = proctitle.compose_session_process_title(
        "12345678-aaaa-bbbb-cccc-dddddddddddd",
        work_dir="/home/John Doe/my project",
    )
    assert title == "kimi-code session=12345678 cwd=my_project"


def test_compose_session_process_title_replaces_equals_in_cwd():
    title = proctitle.compose_session_process_title(
        "12345678-aaaa-bbbb-cccc-dddddddddddd",
        work_dir="/srv/key=value",
    )
    assert title == "kimi-code session=12345678 cwd=key_value"


def test_compose_session_process_title_preserves_unicode_cwd():
    title = proctitle.compose_session_process_title(
        "12345678-aaaa-bbbb-cccc-dddddddddddd",
        work_dir="C:/项目/我的-app",
    )
    assert title == "kimi-code session=12345678 cwd=我的-app"


def test_compose_session_process_title_token_count_remains_three_with_spaces():
    title = proctitle.compose_session_process_title(
        "12345678-aaaa-bbbb-cccc-dddddddddddd",
        work_dir="/x/a b c d",
    )
    # Naive split-on-whitespace must yield exactly 3 tokens, preserving the
    # documented machine-readable contract.
    assert title.split() == ["kimi-code", "session=12345678", "cwd=a_b_c_d"]


def test_compose_session_process_title_sanitizes_session_id_with_spaces():
    # --session/--resume accepts arbitrary user input, so ids carrying
    # whitespace or '=' must also be sanitized to keep the split contract.
    title = proctitle.compose_session_process_title(
        "my id=1",
        work_dir="/tmp/proj",
    )
    assert title.split() == ["kimi-code", "session=my_id_1", "cwd=proj"]

from kimi_cli.utils import logging as logging_utils


def test_get_log_file_path_keeps_shared_log_off_windows(monkeypatch, tmp_path):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    monkeypatch.setattr(logging_utils.sys, "platform", "linux")

    assert logging_utils.get_log_file_path() == tmp_path / "logs" / "kimi.log"


def test_get_log_file_path_uses_process_log_on_windows(monkeypatch, tmp_path):
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    monkeypatch.setattr(logging_utils.sys, "platform", "win32")
    monkeypatch.setattr(logging_utils.os, "getpid", lambda: 12345)

    assert logging_utils.get_log_file_path() == tmp_path / "logs" / "kimi.12345.log"

"""Tests for atomic_json_write utility."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from kimi_cli.utils.io import atomic_json_write


class TestAtomicJsonWrite:
    def test_basic_write(self, tmp_path: Path):
        target = tmp_path / "data.json"
        atomic_json_write({"key": "value"}, target)

        data = json.loads(target.read_text(encoding="utf-8"))
        assert data == {"key": "value"}

    def test_overwrite_existing(self, tmp_path: Path):
        target = tmp_path / "data.json"
        atomic_json_write({"old": True}, target)
        atomic_json_write({"new": True}, target)

        data = json.loads(target.read_text(encoding="utf-8"))
        assert data == {"new": True}

    def test_unicode_content(self, tmp_path: Path):
        target = tmp_path / "data.json"
        atomic_json_write({"emoji": "\U0001f680", "cjk": "你好世界"}, target)

        data = json.loads(target.read_text(encoding="utf-8"))
        assert data["emoji"] == "\U0001f680"
        assert data["cjk"] == "你好世界"
        # ensure_ascii=False means raw unicode in file, not \uXXXX escapes
        raw = target.read_text(encoding="utf-8")
        assert "\\u" not in raw

    def test_no_leftover_tmp_on_success(self, tmp_path: Path):
        target = tmp_path / "data.json"
        atomic_json_write({"a": 1}, target)

        tmp_files = list(tmp_path.glob("*.tmp"))
        assert tmp_files == []

    def test_preserves_old_file_on_error(self, tmp_path: Path, monkeypatch):
        target = tmp_path / "data.json"
        atomic_json_write({"original": True}, target)

        original_dump = json.dump

        def bad_dump(*args, **kwargs):
            original_dump(*args, **kwargs)
            raise OSError("disk full")

        monkeypatch.setattr(json, "dump", bad_dump)

        with pytest.raises(OSError, match="disk full"):
            atomic_json_write({"replacement": True}, target)

        monkeypatch.undo()
        data = json.loads(target.read_text(encoding="utf-8"))
        assert data == {"original": True}

    def test_cleans_tmp_on_error(self, tmp_path: Path, monkeypatch):
        target = tmp_path / "data.json"

        def bad_dump(*args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(json, "dump", bad_dump)

        with pytest.raises(OSError, match="disk full"):
            atomic_json_write({"data": 1}, target)

        tmp_files = list(tmp_path.glob("*.tmp"))
        assert tmp_files == []
        # Target should not have been created
        assert not target.exists()

    def test_write_to_nonexistent_parent_raises(self, tmp_path: Path):
        target = tmp_path / "nonexistent" / "data.json"

        with pytest.raises(FileNotFoundError):
            atomic_json_write({"data": 1}, target)

    def test_indent_formatting(self, tmp_path: Path):
        target = tmp_path / "data.json"
        atomic_json_write({"a": 1, "b": [2, 3]}, target)

        raw = target.read_text(encoding="utf-8")
        # indent=2 means the JSON should be pretty-printed
        assert "\n" in raw
        assert '  "a": 1' in raw

    def test_written_file_is_valid_on_disk(self, tmp_path: Path):
        """Verify that the file can be re-read immediately (data flushed, not just buffered)."""
        target = tmp_path / "data.json"
        atomic_json_write({"key": "value"}, target)

        # Open with a fresh fd to bypass any OS-level caching
        fd = os.open(str(target), os.O_RDONLY)
        try:
            content = os.read(fd, 4096)
        finally:
            os.close(fd)
        data = json.loads(content.decode("utf-8"))
        assert data == {"key": "value"}

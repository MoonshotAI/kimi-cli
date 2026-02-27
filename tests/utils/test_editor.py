"""Tests for the external editor utilities."""

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from kimi_cli.utils.editor import (
    edit_text_in_editor,
    get_editor_command,
)

# ---------------------------------------------------------------------------
# get_editor_command
# ---------------------------------------------------------------------------


class TestGetEditorCommand:
    """Tests for get_editor_command()."""

    def test_configured_takes_highest_priority(self, monkeypatch: pytest.MonkeyPatch):
        """Configured editor should override $VISUAL, $EDITOR, and auto-detect."""
        monkeypatch.setenv("VISUAL", "emacs")
        monkeypatch.setenv("EDITOR", "nano")
        assert get_editor_command("vim") == ["vim"]

    def test_configured_with_args(self):
        """Configured editor string with arguments should be split correctly."""
        assert get_editor_command("code --wait") == ["code", "--wait"]
        assert get_editor_command("/usr/local/bin/vim -u NONE") == [
            "/usr/local/bin/vim",
            "-u",
            "NONE",
        ]

    def test_configured_invalid_shlex(self):
        """Invalid shlex input should fall through to env vars."""
        # Unterminated quote is invalid for shlex.split
        with patch.dict(os.environ, {"VISUAL": "vim"}, clear=False):
            result = get_editor_command("vim 'unterminated")
            assert result == ["vim"]  # Falls through to $VISUAL

    def test_visual_env_var(self, monkeypatch: pytest.MonkeyPatch):
        """$VISUAL should take priority over $EDITOR."""
        monkeypatch.setenv("VISUAL", "code --wait")
        monkeypatch.setenv("EDITOR", "nano")
        assert get_editor_command() == ["code", "--wait"]

    def test_editor_env_var(self, monkeypatch: pytest.MonkeyPatch):
        """$EDITOR should be used when $VISUAL is not set."""
        monkeypatch.delenv("VISUAL", raising=False)
        monkeypatch.setenv("EDITOR", "vim")
        assert get_editor_command() == ["vim"]

    def test_invalid_visual_falls_through_to_editor(self, monkeypatch: pytest.MonkeyPatch):
        """Invalid $VISUAL should fall through to $EDITOR."""
        monkeypatch.setenv("VISUAL", "vim 'unterminated")
        monkeypatch.setenv("EDITOR", "nano")
        assert get_editor_command() == ["nano"]

    def test_auto_detect_order(self, monkeypatch: pytest.MonkeyPatch):
        """Auto-detect should try candidates in order: code, vim, vi, nano."""
        monkeypatch.delenv("VISUAL", raising=False)
        monkeypatch.delenv("EDITOR", raising=False)

        # Only vim is available
        def fake_which(binary: str) -> str | None:
            return "/usr/bin/vim" if binary == "vim" else None

        with patch("kimi_cli.utils.editor.shutil.which", side_effect=fake_which):
            assert get_editor_command() == ["vim"]

    def test_auto_detect_prefers_code(self, monkeypatch: pytest.MonkeyPatch):
        """Auto-detect should prefer 'code --wait' when available."""
        monkeypatch.delenv("VISUAL", raising=False)
        monkeypatch.delenv("EDITOR", raising=False)

        def fake_which(binary: str) -> str | None:
            return f"/usr/bin/{binary}" if binary in ("code", "vim") else None

        with patch("kimi_cli.utils.editor.shutil.which", side_effect=fake_which):
            assert get_editor_command() == ["code", "--wait"]

    def test_returns_none_when_nothing_available(self, monkeypatch: pytest.MonkeyPatch):
        """Should return None when no editor is found."""
        monkeypatch.delenv("VISUAL", raising=False)
        monkeypatch.delenv("EDITOR", raising=False)

        with patch("kimi_cli.utils.editor.shutil.which", return_value=None):
            assert get_editor_command() is None

    def test_empty_configured_is_ignored(self, monkeypatch: pytest.MonkeyPatch):
        """Empty configured string should be treated as not configured."""
        monkeypatch.setenv("EDITOR", "nano")
        assert get_editor_command("") == ["nano"]

    def test_empty_env_vars_are_ignored(self, monkeypatch: pytest.MonkeyPatch):
        """Empty $VISUAL/$EDITOR should fall through to auto-detect."""
        monkeypatch.setenv("VISUAL", "")
        monkeypatch.setenv("EDITOR", "")

        with patch("kimi_cli.utils.editor.shutil.which", return_value=None):
            assert get_editor_command() is None


# ---------------------------------------------------------------------------
# edit_text_in_editor
# ---------------------------------------------------------------------------


class TestEditTextInEditor:
    """Tests for edit_text_in_editor()."""

    def _make_fake_editor(self, tmp_path: Path, *, modify: bool = True) -> str:
        """Create a shell script that acts as a fake editor.

        If *modify* is True, the script appends text to the file (simulating a save).
        If False, it does nothing (simulating :q! without saving).
        """
        script = tmp_path / "fake-editor.sh"
        if modify:
            script.write_text('#!/bin/sh\necho "edited line" >> "$1"\n')
        else:
            script.write_text("#!/bin/sh\nexit 0\n")
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        return str(script)

    def test_basic_edit(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        """Editor modifies the file — should return edited content."""
        editor = self._make_fake_editor(tmp_path, modify=True)
        result = edit_text_in_editor("original text", configured=editor)
        assert result is not None
        assert "original text" in result
        assert "edited line" in result

    def test_no_save_returns_none(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        """Editor exits without modifying — should return None."""
        editor = self._make_fake_editor(tmp_path, modify=False)
        result = edit_text_in_editor("original text", configured=editor)
        assert result is None

    def test_editor_nonzero_exit_returns_none(self, tmp_path: Path):
        """Editor exiting with non-zero code — should return None."""
        script = tmp_path / "failing-editor.sh"
        script.write_text("#!/bin/sh\nexit 1\n")
        script.chmod(script.stat().st_mode | stat.S_IEXEC)

        result = edit_text_in_editor("text", configured=str(script))
        assert result is None

    def test_editor_not_found_returns_none(self):
        """Non-existent editor binary — should return None."""
        result = edit_text_in_editor("text", configured="/nonexistent/editor")
        assert result is None

    def test_no_editor_available_returns_none(self, monkeypatch: pytest.MonkeyPatch):
        """No editor available at all — should return None."""
        monkeypatch.delenv("VISUAL", raising=False)
        monkeypatch.delenv("EDITOR", raising=False)
        with patch("kimi_cli.utils.editor.shutil.which", return_value=None):
            result = edit_text_in_editor("text")
            assert result is None

    def test_trailing_newline_stripped(self, tmp_path: Path):
        """Editors typically add a trailing newline — it should be stripped."""
        script = tmp_path / "newline-editor.sh"
        # Overwrite file with content that has a trailing newline
        script.write_text('#!/bin/sh\nprintf "hello world\\n" > "$1"\n')
        script.chmod(script.stat().st_mode | stat.S_IEXEC)

        result = edit_text_in_editor("", configured=str(script))
        assert result == "hello world"

    def test_multiple_trailing_newlines_only_one_stripped(self, tmp_path: Path):
        """Only one trailing newline should be stripped."""
        script = tmp_path / "multi-nl-editor.sh"
        script.write_text('#!/bin/sh\nprintf "line1\\nline2\\n\\n" > "$1"\n')
        script.chmod(script.stat().st_mode | stat.S_IEXEC)

        result = edit_text_in_editor("", configured=str(script))
        assert result == "line1\nline2\n"

    def test_temp_file_cleaned_up(self, tmp_path: Path):
        """Temporary file should be removed after editing."""
        editor = self._make_fake_editor(tmp_path, modify=True)
        created_files_before = set(Path(tempfile.gettempdir()).glob("kimi-edit-*"))

        edit_text_in_editor("text", configured=editor)

        created_files_after = set(Path(tempfile.gettempdir()).glob("kimi-edit-*"))
        # No new kimi-edit temp files should remain
        assert created_files_after == created_files_before

    def test_temp_file_cleaned_up_on_error(self, tmp_path: Path):
        """Temporary file should be cleaned up even when editor fails."""
        created_files_before = set(Path(tempfile.gettempdir()).glob("kimi-edit-*"))

        edit_text_in_editor("text", configured="/nonexistent/editor")

        created_files_after = set(Path(tempfile.gettempdir()).glob("kimi-edit-*"))
        assert created_files_after == created_files_before

    def test_empty_input_text(self, tmp_path: Path):
        """Editing empty text should work."""
        script = tmp_path / "write-editor.sh"
        script.write_text('#!/bin/sh\nprintf "new content" > "$1"\n')
        script.chmod(script.stat().st_mode | stat.S_IEXEC)

        result = edit_text_in_editor("", configured=str(script))
        assert result == "new content"

    def test_unicode_content(self, tmp_path: Path):
        """Unicode content should roundtrip correctly."""
        editor = self._make_fake_editor(tmp_path, modify=True)
        result = edit_text_in_editor("你好世界 🌍", configured=editor)
        assert result is not None
        assert "你好世界 🌍" in result

    def test_multiline_content(self, tmp_path: Path):
        """Multi-line content should be preserved."""
        editor = self._make_fake_editor(tmp_path, modify=True)
        original = "line 1\nline 2\nline 3"
        result = edit_text_in_editor(original, configured=editor)
        assert result is not None
        assert "line 1\nline 2\nline 3" in result

    def test_subprocess_call_uses_clean_env(self, tmp_path: Path):
        """subprocess.call should be invoked with get_clean_env()."""
        editor = self._make_fake_editor(tmp_path, modify=True)

        with patch("kimi_cli.utils.editor.subprocess.call", return_value=0) as mock_call:
            # Need to also patch get_editor_command to return our editor
            # since subprocess.call is mocked, mtime won't change
            edit_text_in_editor("text", configured=editor)
            assert mock_call.called
            _, kwargs = mock_call.call_args
            assert "env" in kwargs

    def test_temp_file_has_md_suffix(self, tmp_path: Path):
        """Temporary file should have .md suffix for syntax highlighting."""
        captured_path = []

        original_call = subprocess.call

        def spy_call(cmd, **kwargs):
            # cmd is like [editor, tmpfile]
            captured_path.append(cmd[-1])
            return original_call(cmd, **kwargs)

        editor = self._make_fake_editor(tmp_path, modify=True)
        with patch("kimi_cli.utils.editor.subprocess.call", side_effect=spy_call):
            edit_text_in_editor("text", configured=editor)

        assert len(captured_path) == 1
        assert captured_path[0].endswith(".md")


# ---------------------------------------------------------------------------
# Config integration
# ---------------------------------------------------------------------------


class TestConfigIntegration:
    """Tests for editor config field."""

    def test_default_editor_empty_by_default(self):
        """default_editor should default to empty string."""
        from kimi_cli.config import get_default_config

        config = get_default_config()
        assert config.default_editor == ""

    def test_load_config_with_editor(self):
        """Config with default_editor should load correctly."""
        from kimi_cli.config import load_config_from_string

        config = load_config_from_string('default_editor = "vim"\n')
        assert config.default_editor == "vim"

    def test_load_config_with_editor_args(self):
        """Config with editor command containing args should load correctly."""
        from kimi_cli.config import load_config_from_string

        config = load_config_from_string('default_editor = "code --wait"\n')
        assert config.default_editor == "code --wait"

    def test_existing_config_without_editor_field(self):
        """Existing config without default_editor should default to empty."""
        from kimi_cli.config import load_config_from_string

        config = load_config_from_string('default_model = ""\n')
        assert config.default_editor == ""

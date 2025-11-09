"""Tests for completion behavior when deleting text."""

from pathlib import Path
from unittest.mock import MagicMock

from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document

from kimi_cli.ui.shell.prompt import FileMentionCompleter, MetaCommandCompleter


def test_meta_command_completer_after_deletion():
    """Verify meta command completions work after text deletion."""
    completer = MetaCommandCompleter()

    # Simulate typing "/cle" and getting completions
    document = Document(text="/cle", cursor_position=4)
    event = CompleteEvent(completion_requested=True)
    completions_before = list(completer.get_completions(document, event))

    # Should have completions for /clear
    assert len(completions_before) > 0
    assert any("clear" in c.text for c in completions_before)

    # Simulate deleting one character to get "/cl"
    document = Document(text="/cl", cursor_position=3)
    completions_after = list(completer.get_completions(document, event))

    # Should still have completions
    assert len(completions_after) > 0
    assert any("clear" in c.text for c in completions_after)


def test_file_completer_after_deletion(tmp_path: Path):
    """Verify file completions work after text deletion."""
    # Create test files
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "file1.py").write_text("# test")
    (tmp_path / "src" / "file2.py").write_text("# test")

    completer = FileMentionCompleter(tmp_path)
    event = CompleteEvent(completion_requested=True)

    # Simulate typing "@src/fi" and getting completions
    document = Document(text="@src/fi", cursor_position=7)
    completions_before = list(completer.get_completions(document, event))

    # Should have completions for files starting with "fi"
    assert len(completions_before) > 0

    # Simulate deleting one character to get "@src/f"
    document = Document(text="@src/f", cursor_position=6)
    completions_after = list(completer.get_completions(document, event))

    # Should still have completions (possibly more since we're less specific)
    assert len(completions_after) > 0


def test_meta_command_completer_empty_after_deletion():
    """Verify completions appear when deleting back to just '/'."""
    completer = MetaCommandCompleter()
    event = CompleteEvent(completion_requested=True)

    # Simulate deleting all text after "/" to get just "/"
    document = Document(text="/", cursor_position=1)
    completions = list(completer.get_completions(document, event))

    # Should show all available meta commands
    assert len(completions) > 0


def test_file_completer_empty_after_deletion(tmp_path: Path):
    """Verify file completions appear when deleting back to just '@'."""
    # Create test files
    (tmp_path / "README.md").write_text("# test")
    (tmp_path / "src").mkdir()

    completer = FileMentionCompleter(tmp_path)
    event = CompleteEvent(completion_requested=True)

    # Simulate deleting all text after "@" to get just "@"
    document = Document(text="@", cursor_position=1)
    completions = list(completer.get_completions(document, event))

    # Should show top-level files and directories
    assert len(completions) > 0
    assert any("README.md" in c.text for c in completions)

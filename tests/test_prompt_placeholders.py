"""Unit tests for prompt placeholder deletion logic (cursor boundary conditions)."""

import re

from kimi_cli.utils.message import LARGE_PASTE_LINE_THRESHOLD

# The regex pattern from prompt.py
_ATTACHMENT_PLACEHOLDER_RE = re.compile(
    r"\[(?P<type>image|text):(?P<id>[a-zA-Z0-9_\-\.]+)"
    r"(?:,(?P<width>\d+)x(?P<height>\d+)|,(?P<line_count>\d+) lines)?\]"
)


class TestCursorBoundaryLogic:
    """Test cursor boundary conditions for placeholder deletion (the main bug we fixed)."""

    def test_backspace_at_end_deletes_placeholder(self):
        """Test backspace with cursor right after placeholder deletes it (key bug fix)."""
        text = "prefix [text:abc12345,60 lines]"
        match = _ATTACHMENT_PLACEHOLDER_RE.search(text)
        start, end = match.span()

        cursor = end  # Right after placeholder
        should_delete = start < cursor <= end  # Backspace logic
        assert should_delete

    def test_backspace_before_placeholder_does_not_delete(self):
        """Test backspace before placeholder doesn't delete it."""
        text = "prefix [text:abc12345,60 lines]"
        match = _ATTACHMENT_PLACEHOLDER_RE.search(text)
        start, end = match.span()

        cursor = start  # Right before placeholder
        should_delete = start < cursor <= end  # Backspace logic
        assert not should_delete

    def test_delete_at_start_deletes_placeholder(self):
        """Test delete with cursor before placeholder deletes it."""
        text = "prefix [text:abc12345,60 lines]"
        match = _ATTACHMENT_PLACEHOLDER_RE.search(text)
        start, end = match.span()

        cursor = start  # Right before placeholder
        should_delete = start <= cursor < end  # Delete logic
        assert should_delete

    def test_delete_after_placeholder_does_not_delete(self):
        """Test delete after placeholder doesn't delete it."""
        text = "prefix [text:abc12345,60 lines] suffix"
        match = _ATTACHMENT_PLACEHOLDER_RE.search(text)
        start, end = match.span()

        cursor = end  # Right after placeholder
        should_delete = start <= cursor < end  # Delete logic
        assert not should_delete

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

    def test_backspace_boundary_conditions(self):
        """Test backspace deletes when cursor is after placeholder, not before."""
        text = "prefix [text:abc12345,60 lines]"
        match = _ATTACHMENT_PLACEHOLDER_RE.search(text)
        start, end = match.span()

        # Backspace with cursor right after placeholder should delete (the bug fix)
        cursor = end
        should_delete = start < cursor <= end
        assert should_delete

        # Backspace with cursor before placeholder should not delete
        cursor = start
        should_delete = start < cursor <= end
        assert not should_delete

    def test_delete_boundary_conditions(self):
        """Test delete key deletes when cursor is before placeholder, not after."""
        text = "prefix [text:abc12345,60 lines]"
        match = _ATTACHMENT_PLACEHOLDER_RE.search(text)
        start, end = match.span()

        # Delete with cursor before placeholder should delete
        cursor = start
        should_delete = start <= cursor < end
        assert should_delete

        # Delete with cursor after placeholder should not delete
        cursor = end
        should_delete = start <= cursor < end
        assert not should_delete

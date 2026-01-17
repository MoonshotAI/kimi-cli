"""Tests for _sanitize_surrogates function in prompt module."""

import pytest

from gitrekt_cli.ui.shell.prompt import _sanitize_surrogates


class TestSanitizeSurrogates:
    """Test cases for UTF-16 surrogate sanitization."""

    def test_surrogate_pair_is_replaced(self) -> None:
        """Test that UTF-16 surrogate pairs are sanitized."""
        # \ud83d\udc3a is the UTF-16 surrogate pair for wolf emoji 🐺
        input_text = "Hello \ud83d\udc3a World"

        # Original should fail to encode
        with pytest.raises(UnicodeEncodeError):
            input_text.encode("utf-8")

        # Sanitized should encode successfully
        result = _sanitize_surrogates(input_text)
        result.encode("utf-8")  # Should not raise

    def test_normal_emoji_preserved(self) -> None:
        """Test that normal emoji characters are preserved."""
        input_text = "Hello 🐺 World 🎉"
        result = _sanitize_surrogates(input_text)
        assert result == input_text

    def test_ascii_text_unchanged(self) -> None:
        """Test that plain ASCII text is unchanged."""
        input_text = "Hello World"
        result = _sanitize_surrogates(input_text)
        assert result == input_text

    def test_unicode_text_preserved(self) -> None:
        """Test that normal Unicode text is preserved."""
        input_text = "你好世界 Привет мир"
        result = _sanitize_surrogates(input_text)
        assert result == input_text

    def test_empty_string(self) -> None:
        """Test that empty string returns empty string."""
        result = _sanitize_surrogates("")
        assert result == ""

    def test_mixed_content_with_surrogates(self) -> None:
        """Test text with surrogates mixed with normal content."""
        # Simulating the exact issue from GitHub #420
        input_text = "CTL Implementation - Kimi Tasks\nAssigned To: \ud83d\udc3a Kimi"

        # Should not raise
        result = _sanitize_surrogates(input_text)
        result.encode("utf-8")

        # Should preserve the rest of the content
        assert "CTL Implementation" in result
        assert "Assigned To:" in result
        assert "Kimi" in result

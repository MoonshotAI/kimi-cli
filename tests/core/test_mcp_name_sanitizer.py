"""Tests for MCP tool name sanitization."""

from __future__ import annotations

from kimi_cli.soul.mcp_name_sanitizer import (
    MCPNameSanitizer,
    MCPServerSanitizer,
    get_original_tool_name,
    global_sanitizer,
    is_valid_tool_name,
    sanitize_tool_name,
)


class TestIsValidToolName:
    """Tests for is_valid_tool_name function."""

    def test_valid_names_starting_with_letter(self):
        """Names starting with a letter are valid."""
        assert is_valid_tool_name("valid_name") is True
        assert is_valid_tool_name("anotherValidName") is True
        assert is_valid_tool_name("A") is True
        assert is_valid_tool_name("abc123") is True
        assert is_valid_tool_name("test_tool_1") is True

    def test_valid_names_starting_with_underscore(self):
        """Names starting with underscore are valid."""
        assert is_valid_tool_name("_private") is True
        assert is_valid_tool_name("_") is True

    def test_invalid_names_starting_with_digit(self):
        """Names starting with a digit are invalid."""
        assert is_valid_tool_name("1tool") is False
        assert is_valid_tool_name("21st_magic") is False
        assert is_valid_tool_name("0test") is False

    def test_invalid_names_with_special_chars(self):
        """Names with special characters are invalid."""
        assert is_valid_tool_name("tool-name") is False
        assert is_valid_tool_name("tool.name") is False
        assert is_valid_tool_name("tool/name") is False
        assert is_valid_tool_name("tool@name") is False

    def test_empty_string_is_invalid(self):
        """Empty string is invalid."""
        assert is_valid_tool_name("") is False


class TestMCPServerSanitizer:
    """Tests for MCPServerSanitizer class."""

    def test_sanitize_name_starting_with_digit(self):
        """Names starting with digits get 'n' prefix."""
        sanitizer = MCPServerSanitizer("test_server")

        # Single digit
        assert sanitizer.sanitize_name("1tool") == "n1tool"
        # Multiple digits
        assert sanitizer.sanitize_name("21st_magic") == "n21st_magic"
        assert sanitizer.sanitize_name("123test") == "n123test"

    def test_valid_names_unchanged(self):
        """Valid names are not modified."""
        sanitizer = MCPServerSanitizer("test_server")

        assert sanitizer.sanitize_name("valid_name") == "valid_name"
        assert sanitizer.sanitize_name("tool123") == "tool123"
        assert sanitizer.sanitize_name("_private") == "_private"

    def test_idempotent_sanitization(self):
        """Sanitizing the same name twice returns same result."""
        sanitizer = MCPServerSanitizer("test_server")

        name1 = sanitizer.sanitize_name("21st_magic")
        name2 = sanitizer.sanitize_name("21st_magic")
        assert name1 == name2 == "n21st_magic"

    def test_reverse_mapping(self):
        """Can retrieve original name from sanitized name."""
        sanitizer = MCPServerSanitizer("test_server")

        sanitized = sanitizer.sanitize_name("21st_magic")
        assert sanitized == "n21st_magic"
        assert sanitizer.get_original_name("n21st_magic") == "21st_magic"

    def test_reverse_mapping_for_unchanged_names(self):
        """Valid names also have reverse mapping."""
        sanitizer = MCPServerSanitizer("test_server")

        sanitized = sanitizer.sanitize_name("valid_name")
        assert sanitized == "valid_name"
        assert sanitizer.get_original_name("valid_name") == "valid_name"

    def test_unknown_sanitized_name_returns_none(self):
        """Unknown sanitized names return None."""
        sanitizer = MCPServerSanitizer("test_server")

        assert sanitizer.get_original_name("unknown") is None

    def test_is_sanitized(self):
        """is_sanitized returns True only for modified names."""
        sanitizer = MCPServerSanitizer("test_server")

        sanitizer.sanitize_name("21st_magic")
        sanitizer.sanitize_name("valid_name")

        assert sanitizer.is_sanitized("n21st_magic") is True
        assert sanitizer.is_sanitized("valid_name") is False

    def test_is_sanitized_unknown_name(self):
        """is_sanitized returns False for unknown names."""
        sanitizer = MCPServerSanitizer("test_server")

        assert sanitizer.is_sanitized("unknown") is False


class TestMCPServerSanitizerCollisions:
    """Tests for collision handling in MCPServerSanitizer."""

    def test_collision_different_originals_same_sanitized(self):
        """When two different original names would sanitize to the same value."""
        sanitizer = MCPServerSanitizer("test_server")

        # First name sanitizes to n21st_magic
        first = sanitizer.sanitize_name("21st_magic")
        assert first == "n21st_magic"

        # Second name already starts with 'n' followed by digit
        # n21st_magic is already taken, so it should get a suffix
        second = sanitizer.sanitize_name("n21st_magic")
        # Should be different from first
        assert second != first
        # But should still start with valid character
        assert second.startswith("n")

        # Both should have reverse mappings
        assert sanitizer.get_original_name(first) == "21st_magic"
        assert sanitizer.get_original_name(second) == "n21st_magic"

    def test_no_collision_for_same_original(self):
        """No collision when sanitizing the same name twice."""
        sanitizer = MCPServerSanitizer("test_server")

        first = sanitizer.sanitize_name("21st_magic")
        second = sanitizer.sanitize_name("21st_magic")
        assert first == second


class TestMCPNameSanitizer:
    """Tests for MCPNameSanitizer class."""

    def test_per_server_isolation(self):
        """Different servers have independent sanitizers."""
        manager = MCPNameSanitizer()

        # Same tool name on different servers
        assert manager.sanitize_tool_name("server1", "21st_tool") == "n21st_tool"
        assert manager.sanitize_tool_name("server2", "21st_tool") == "n21st_tool"

        # Reverse lookups work correctly
        assert manager.get_original_tool_name("server1", "n21st_tool") == "21st_tool"
        assert manager.get_original_tool_name("server2", "n21st_tool") == "21st_tool"

    def test_remove_server(self):
        """Can remove a server's sanitizer."""
        manager = MCPNameSanitizer()

        manager.sanitize_tool_name("server1", "21st_tool")
        manager.remove_server("server1")

        # After removal, lookup should fail
        assert manager.get_original_tool_name("server1", "n21st_tool") is None

    def test_clear_all_servers(self):
        """Can clear all sanitizers."""
        manager = MCPNameSanitizer()

        manager.sanitize_tool_name("server1", "21st_tool")
        manager.sanitize_tool_name("server2", "22nd_tool")
        manager.clear()

        # After clear, lookups should fail
        assert manager.get_original_tool_name("server1", "n21st_tool") is None
        assert manager.get_original_tool_name("server2", "n22nd_tool") is None


class TestGlobalSanitizer:
    """Tests for the global sanitizer convenience functions."""

    def setup_method(self):
        """Clear global sanitizer before each test."""
        global_sanitizer.clear()

    def teardown_method(self):
        """Clear global sanitizer after each test."""
        global_sanitizer.clear()

    def test_sanitize_tool_name_global(self):
        """Global sanitize_tool_name function works."""
        assert sanitize_tool_name("server", "21st_tool") == "n21st_tool"
        assert sanitize_tool_name("server", "valid") == "valid"

    def test_get_original_tool_name_global(self):
        """Global get_original_tool_name function works."""
        sanitize_tool_name("server", "21st_tool")
        assert get_original_tool_name("server", "n21st_tool") == "21st_tool"


class TestEdgeCases:
    """Tests for edge cases."""

    def test_very_long_name_starting_with_digit(self):
        """Long names starting with digits are handled."""
        sanitizer = MCPServerSanitizer("test_server")
        long_name = "1" + "a" * 200
        sanitized = sanitizer.sanitize_name(long_name)
        assert sanitized.startswith("n")
        assert sanitized[1:] == long_name

    def test_name_with_only_digits(self):
        """Names that are just digits."""
        sanitizer = MCPServerSanitizer("test_server")
        assert sanitizer.sanitize_name("12345") == "n12345"

    def test_name_with_leading_zeros(self):
        """Names with leading zeros."""
        sanitizer = MCPServerSanitizer("test_server")
        assert sanitizer.sanitize_name("007") == "n007"

    def test_unicode_in_name(self):
        """Names with unicode characters (should be sanitized)."""
        sanitizer = MCPServerSanitizer("test_server")
        # Unicode characters get replaced with underscores
        sanitized = sanitizer.sanitize_name("tool_名称")
        assert sanitized.startswith("n") or "_" in sanitized


class TestRealWorldExamples:
    """Tests based on real-world MCP server tool names."""

    def test_21st_dev_magic_mcp_example(self):
        """The 21st.dev Magic MCP server example from the issue."""
        sanitizer = MCPServerSanitizer("21st-magic")

        # Original problematic name
        original = "21st_magic_component_builder"
        sanitized = sanitizer.sanitize_name(original)

        # Should start with 'n' prefix
        assert sanitized == "n21st_magic_component_builder"
        assert is_valid_tool_name(sanitized) is True

        # Reverse lookup
        assert sanitizer.get_original_name(sanitized) == original

    def test_multiple_tools_from_same_server(self):
        """Multiple tools from the same server."""
        sanitizer = MCPServerSanitizer("my-mcp-server")

        tools = [
            ("21st_magic_component_builder", "n21st_magic_component_builder"),
            ("valid_tool", "valid_tool"),
            ("123_start", "n123_start"),
            ("_private", "_private"),
        ]

        for original, expected in tools:
            sanitized = sanitizer.sanitize_name(original)
            assert sanitized == expected, f"Failed for {original}"
            assert sanitizer.get_original_name(sanitized) == original

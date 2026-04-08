"""MCP tool name sanitization for LLM API compatibility.

The Kimi API requires function names to match ^[a-zA-Z_][a-zA-Z0-9_]*$, but some MCP
servers return tool names starting with digits (e.g., 21st_magic_component_builder).
This module provides bidirectional name mapping to sanitize non-compliant names.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from kimi_cli import logger

# Pattern for valid tool names according to Kimi API
VALID_NAME_PATTERN = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")

# Pattern to detect if a name starts with a digit (needs sanitization)
STARTS_WITH_DIGIT_PATTERN = re.compile(r"^\d")

# Prefix used for sanitized names (must start with a letter)
SANITIZE_PREFIX = "n"

# Pattern to detect sanitized names (for reverse mapping)
SANITIZED_NAME_PATTERN = re.compile(rf"^{SANITIZE_PREFIX}(\d.*)$")


@dataclass(slots=True)
class MCPServerSanitizer:
    """Manages name sanitization for a single MCP server.

    Maintains bidirectional mappings between original tool names (used for MCP calls)
    and sanitized names (used for LLM API).
    """

    server_name: str
    _original_to_sanitized: dict[str, str] = field(default_factory=dict, repr=False)
    _sanitized_to_original: dict[str, str] = field(default_factory=dict, repr=False)

    def sanitize_name(self, original_name: str) -> str:
        """Sanitize a tool name to comply with LLM API requirements.

        If the name already complies with the naming convention, it's returned as-is.
        If the name starts with a digit, a prefix is prepended.

        Args:
            original_name: The original tool name from the MCP server.

        Returns:
            The sanitized name suitable for LLM API use.
        """
        # Check if already mapped
        if original_name in self._original_to_sanitized:
            return self._original_to_sanitized[original_name]

        # Determine the sanitized name
        if VALID_NAME_PATTERN.match(original_name):
            # Name is already valid, use as-is
            sanitized = original_name
        else:
            # Sanitize invalid characters first (replace with underscores)
            sanitized = re.sub(r"[^a-zA-Z0-9_]", "_", original_name)
            # Ensure it starts with a valid character (letter or underscore)
            if (
                not sanitized
                or STARTS_WITH_DIGIT_PATTERN.match(sanitized)
                or (not sanitized[0].isalpha() and sanitized[0] != "_")
            ):
                sanitized = f"{SANITIZE_PREFIX}{sanitized}"

        # Check for collisions (including when a valid name conflicts with a sanitized name)
        if sanitized in self._sanitized_to_original:
            existing_original = self._sanitized_to_original[sanitized]
            if existing_original != original_name:
                logger.warning(
                    "MCP tool name collision detected for server '{server}': "
                    "'{new_original}' and '{existing_original}' both map to '{sanitized}'",
                    server=self.server_name,
                    new_original=original_name,
                    existing_original=existing_original,
                    sanitized=sanitized,
                )
                # Add disambiguation suffix
                counter = 1
                base_sanitized = sanitized
                while sanitized in self._sanitized_to_original:
                    sanitized = f"{base_sanitized}_{counter}"
                    counter += 1

        self._original_to_sanitized[original_name] = sanitized
        self._sanitized_to_original[sanitized] = original_name

        if sanitized != original_name:
            logger.debug(
                "Sanitized MCP tool name for server '{server}': '{original}' -> '{sanitized}'",
                server=self.server_name,
                original=original_name,
                sanitized=sanitized,
            )

        return sanitized

    def get_original_name(self, sanitized_name: str) -> str | None:
        """Get the original tool name from a sanitized name.

        Args:
            sanitized_name: The sanitized name used by the LLM API.

        Returns:
            The original tool name for MCP calls, or None if not found.
        """
        return self._sanitized_to_original.get(sanitized_name)

    def is_sanitized(self, name: str) -> bool:
        """Check if a name was sanitized (differs from its original)."""
        if name not in self._sanitized_to_original:
            return False
        return self._sanitized_to_original[name] != name


class MCPNameSanitizer:
    """Global manager for MCP tool name sanitization across all servers."""

    def __init__(self) -> None:
        self._server_sanitizers: dict[str, MCPServerSanitizer] = {}

    def get_server_sanitizer(self, server_name: str) -> MCPServerSanitizer:
        """Get or create a sanitizer for a specific MCP server."""
        if server_name not in self._server_sanitizers:
            self._server_sanitizers[server_name] = MCPServerSanitizer(server_name)
        return self._server_sanitizers[server_name]

    def sanitize_tool_name(self, server_name: str, original_name: str) -> str:
        """Sanitize a tool name for a specific server.

        Args:
            server_name: The MCP server name.
            original_name: The original tool name from the server.

        Returns:
            The sanitized name.
        """
        sanitizer = self.get_server_sanitizer(server_name)
        return sanitizer.sanitize_name(original_name)

    def get_original_tool_name(self, server_name: str, sanitized_name: str) -> str | None:
        """Get the original tool name for a specific server.

        Args:
            server_name: The MCP server name.
            sanitized_name: The sanitized name.

        Returns:
            The original tool name, or None if not found.
        """
        sanitizer = self._server_sanitizers.get(server_name)
        if sanitizer is None:
            return None
        return sanitizer.get_original_name(sanitized_name)

    def remove_server(self, server_name: str) -> None:
        """Remove a server's sanitizer (cleanup when server is disconnected)."""
        if server_name in self._server_sanitizers:
            del self._server_sanitizers[server_name]

    def clear(self) -> None:
        """Clear all sanitizers."""
        self._server_sanitizers.clear()


# Global instance for use across the application
global_sanitizer: MCPNameSanitizer = MCPNameSanitizer()


def sanitize_tool_name(server_name: str, original_name: str) -> str:
    """Convenience function to sanitize a tool name using the global sanitizer."""
    return global_sanitizer.sanitize_tool_name(server_name, original_name)


def get_original_tool_name(server_name: str, sanitized_name: str) -> str | None:
    """Convenience function to get original name using the global sanitizer."""
    return global_sanitizer.get_original_tool_name(server_name, sanitized_name)


def is_valid_tool_name(name: str) -> bool:
    """Check if a tool name is valid according to Kimi API requirements."""
    return bool(VALID_NAME_PATTERN.match(name))

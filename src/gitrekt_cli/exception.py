from __future__ import annotations


class GitrektCLIException(Exception):
    """Base exception class for Gitrekt CLI."""

    pass


class ConfigError(GitrektCLIException, ValueError):
    """Configuration error."""

    pass


class AgentSpecError(GitrektCLIException, ValueError):
    """Agent specification error."""

    pass


class InvalidToolError(GitrektCLIException, ValueError):
    """Invalid tool error."""

    pass


class MCPConfigError(GitrektCLIException, ValueError):
    """MCP config error."""

    pass


class MCPRuntimeError(GitrektCLIException, RuntimeError):
    """MCP runtime error."""

    pass

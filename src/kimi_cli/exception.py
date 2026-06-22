from __future__ import annotations

__all__ = (
    "KimiCLIException",
    "ConfigError",
    "AgentSpecError",
    "InvalidToolError",
    "SystemPromptTemplateError",
    "MCPConfigError",
    "MCPRuntimeError",
)


class KimiCLIException(Exception):
    """Base exception class for Kimi Code CLI."""


class ConfigError(KimiCLIException, ValueError):
    """Configuration error."""


class AgentSpecError(KimiCLIException, ValueError):
    """Agent specification error."""


class InvalidToolError(KimiCLIException, ValueError):
    """Invalid tool error."""


class SystemPromptTemplateError(KimiCLIException, ValueError):
    """System prompt template error."""


class MCPConfigError(KimiCLIException, ValueError):
    """MCP config error."""


class MCPRuntimeError(KimiCLIException, RuntimeError):
    """MCP runtime error."""

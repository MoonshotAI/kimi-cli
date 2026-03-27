from __future__ import annotations

from typing import Any


class KimiCLIException(Exception):
    """Base exception class for Kimi Code CLI.

    Provides structured error context for better debugging and user feedback.
    """

    def __init__(self, message: str, *, context: dict[str, Any] | None = None):
        super().__init__(message)
        self.message = message
        self.context = context or {}

    def __str__(self) -> str:
        if self.context:
            context_str = ", ".join(f"{k}={v!r}" for k, v in self.context.items())
            return f"{self.message} ({context_str})"
        return self.message


class ConfigError(KimiCLIException, ValueError):
    """Configuration error.

    Attributes:
        config_path: Path to the configuration file that caused the error, if applicable.
        field: Specific configuration field that failed validation, if known.
    """

    def __init__(
        self,
        message: str,
        *,
        config_path: str | None = None,
        field: str | None = None,
        context: dict[str, Any] | None = None,
    ):
        ctx = context or {}
        if config_path:
            ctx["config_path"] = config_path
        if field:
            ctx["field"] = field
        super().__init__(message, context=ctx)
        self.config_path = config_path
        self.field = field


class AgentSpecError(KimiCLIException, ValueError):
    """Agent specification error.

    Attributes:
        agent_file: Path to the agent specification file, if applicable.
    """

    def __init__(
        self,
        message: str,
        *,
        agent_file: str | None = None,
        context: dict[str, Any] | None = None,
    ):
        ctx = context or {}
        if agent_file:
            ctx["agent_file"] = agent_file
        super().__init__(message, context=ctx)
        self.agent_file = agent_file


class InvalidToolError(KimiCLIException, ValueError):
    """Invalid tool error.

    Attributes:
        tool_name: Name of the invalid tool.
        reason: Specific reason why the tool is invalid.
    """

    def __init__(
        self,
        message: str,
        *,
        tool_name: str | None = None,
        reason: str | None = None,
        context: dict[str, Any] | None = None,
    ):
        ctx = context or {}
        if tool_name:
            ctx["tool_name"] = tool_name
        if reason:
            ctx["reason"] = reason
        super().__init__(message, context=ctx)
        self.tool_name = tool_name
        self.reason = reason


class SystemPromptTemplateError(KimiCLIException, ValueError):
    """System prompt template error."""

    pass


class MCPConfigError(KimiCLIException, ValueError):
    """MCP config error.

    Attributes:
        server_name: Name of the MCP server with configuration issues.
    """

    def __init__(
        self,
        message: str,
        *,
        server_name: str | None = None,
        context: dict[str, Any] | None = None,
    ):
        ctx = context or {}
        if server_name:
            ctx["server_name"] = server_name
        super().__init__(message, context=ctx)
        self.server_name = server_name


class MCPRuntimeError(KimiCLIException, RuntimeError):
    """MCP runtime error.

    Attributes:
        server_name: Name of the MCP server that encountered an error.
        exit_code: Process exit code if the server process terminated.
    """

    def __init__(
        self,
        message: str,
        *,
        server_name: str | None = None,
        exit_code: int | None = None,
        context: dict[str, Any] | None = None,
    ):
        ctx = context or {}
        if server_name:
            ctx["server_name"] = server_name
        if exit_code is not None:
            ctx["exit_code"] = exit_code
        super().__init__(message, context=ctx)
        self.server_name = server_name
        self.exit_code = exit_code

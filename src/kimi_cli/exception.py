from __future__ import annotations

from rich.console import Console

console = Console()


class KimiCLIException(Exception):
    """Base exception class for Kimi Code CLI."""

    def __init__(self, message: str):
        self.message = message
        console.print(f"[red]Error: {self.message}[red]")
        super().__init__(self.message)


class ConfigError(KimiCLIException, ValueError):
    """Configuration error."""

    pass


class AgentSpecError(KimiCLIException, ValueError):
    """Agent specification error."""

    pass


class InvalidToolError(KimiCLIException, ValueError):
    """Invalid tool error."""

    pass


class MCPConfigError(KimiCLIException, ValueError):
    """MCP config error."""

    pass


class MCPRuntimeError(KimiCLIException, RuntimeError):
    """MCP runtime error."""

    pass

from __future__ import annotations


class KimiCLIException(Exception):
    """Base exception class for Kimi CLI."""

    pass


class ConfigError(KimiCLIException):
    """Configuration error."""

    pass


class AgentSpecError(KimiCLIException):
    """Agent specification error."""

    pass

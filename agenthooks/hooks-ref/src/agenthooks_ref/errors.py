"""Exception classes for agenthooks-ref."""


class HookError(Exception):
    """Base exception for hook-related errors."""

    pass


class ParseError(HookError):
    """Raised when HOOK.md parsing fails."""

    pass


class ValidationError(HookError):
    """Raised when hook validation fails."""

    pass


class DiscoveryError(HookError):
    """Raised when hook discovery fails."""

    pass

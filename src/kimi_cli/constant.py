from __future__ import annotations

from functools import cache
from typing import TYPE_CHECKING

NAME = "Kimi Code CLI"

# UI formatting constants
DESCRIPTION_MAX_LEN = 60
DESCRIPTION_TRUNCATE_LEN = 57

# Default timeouts (seconds)
BG_TASK_SHUTDOWN_TIMEOUT = 2.0

if TYPE_CHECKING:
    VERSION: str
    USER_AGENT: str


@cache
def get_version() -> str:
    """Return the installed version of kimi-cli."""
    from importlib import metadata

    return metadata.version("kimi-cli")


@cache
def get_user_agent() -> str:
    """Return the User-Agent string for outbound HTTP requests."""
    return f"KimiCLI/{get_version()}"


def __getattr__(name: str) -> str:
    if name == "VERSION":
        return get_version()
    if name == "USER_AGENT":
        return get_user_agent()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["NAME", "VERSION", "USER_AGENT", "get_version", "get_user_agent"]

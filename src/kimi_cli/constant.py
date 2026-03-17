from __future__ import annotations

from functools import cache

NAME = "Kimi Code CLI"


@cache
def get_version() -> str:
    from importlib import metadata

    return metadata.version("kimi-cli")


@cache
def get_user_agent() -> str:
    return f"KimiCLI/{get_version()}"


def __getattr__(name: str) -> str:
    if name == "VERSION":
        return get_version()
    if name == "USER_AGENT":
        return get_user_agent()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["NAME", "VERSION", "USER_AGENT", "get_version", "get_user_agent"]

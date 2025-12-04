from __future__ import annotations

from dataclasses import dataclass
from typing import Any


class ToolDependencyError(Exception):
    """Raised when a required dependency is missing while instantiating a tool."""

    def __init__(self, tool_path: str, dependency: type[Any]):
        self.tool_path = tool_path
        self.dependency = dependency
        super().__init__(f"Missing dependency {dependency!r} for tool {tool_path}")


class ToolLoadError(Exception):
    """Raised when a tool cannot be loaded for reasons other than missing deps."""

    def __init__(self, tool_path: str, reason: str):
        self.tool_path = tool_path
        self.reason = reason
        super().__init__(f"Failed to load tool {tool_path}: {reason}")


@dataclass(frozen=True, slots=True)
class ToolLoadIssue:
    path: str
    reason: str


class Injector:
    """Minimal dependency injector for tool wiring."""

    def __init__(self, providers: dict[type[Any], Any]):
        self._providers = providers

    def require(self, dep: type[Any], *, tool_path: str) -> Any:
        try:
            return self._providers[dep]
        except KeyError as e:
            raise ToolDependencyError(tool_path, dep) from e

    def optional(self, dep: type[Any], default: Any = None) -> Any:
        return self._providers.get(dep, default)

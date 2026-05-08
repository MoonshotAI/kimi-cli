from __future__ import annotations

from collections.abc import Mapping

from kimi_cli.subagents.models import AgentTypeDefinition


class LaborMarket:
    """Registry of built-in subagent types."""

    def __init__(self) -> None:
        self._builtin_types: dict[str, AgentTypeDefinition] = {}

    @property
    def builtin_types(self) -> Mapping[str, AgentTypeDefinition]:
        return self._builtin_types

    def add_builtin_type(self, type_def: AgentTypeDefinition) -> None:
        self._builtin_types[type_def.name] = type_def

    def get_builtin_type(self, name: str) -> AgentTypeDefinition | None:
        return self._builtin_types.get(name)

    def require_builtin_type(self, name: str) -> AgentTypeDefinition:
        type_def = self.get_builtin_type(name)
        if type_def is None:
            raise KeyError(f"Builtin subagent type not found: {name}")
        return type_def

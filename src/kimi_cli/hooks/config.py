from __future__ import annotations

import re
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class HookEventType(str, Enum):
    """Hook event types."""

    # Session lifecycle
    SESSION_START = "session_start"
    SESSION_END = "session_end"

    # Agent loop
    BEFORE_AGENT = "before_agent"
    AFTER_AGENT = "after_agent"

    # Tool interception
    BEFORE_TOOL = "before_tool"
    AFTER_TOOL = "after_tool"
    AFTER_TOOL_FAILURE = "after_tool_failure"

    # Subagent lifecycle
    SUBAGENT_START = "subagent_start"
    SUBAGENT_STOP = "subagent_stop"

    # Context management
    PRE_COMPACT = "pre_compact"


class HookType(str, Enum):
    """Hook implementation types."""

    COMMAND = "command"
    PROMPT = "prompt"
    AGENT = "agent"


class HookMatcher(BaseModel):
    """Matcher for filtering hook execution."""

    tool: str | None = Field(default=None, description="Tool name pattern (regex)")
    pattern: str | None = Field(default=None, description="Argument pattern (regex)")

    def matches(
        self,
        tool_name: str | None = None,
        arguments: dict[str, Any] | None = None,
    ) -> bool:
        """Check if the matcher matches the given context."""
        if self.tool is not None and tool_name is not None and not re.search(self.tool, tool_name):
            return False
        if self.pattern is not None and arguments is not None:
            args_str = str(arguments)
            if not re.search(self.pattern, args_str):
                return False
        return True


class BaseHookConfig(BaseModel):
    """Base hook configuration."""

    name: str | None = Field(default=None, description="Hook name for identification")
    type: HookType = Field(default=HookType.COMMAND, description="Hook type")
    matcher: HookMatcher | None = Field(default=None, description="Execution matcher")
    timeout: int = Field(default=30000, ge=100, le=600000, description="Timeout in milliseconds")
    description: str | None = Field(default=None, description="Hook description")


class CommandHookConfig(BaseHookConfig):
    """Command hook configuration."""

    model_config = {"populate_by_name": True}

    type: Literal[HookType.COMMAND] = HookType.COMMAND
    command: str = Field(description="Shell command to execute")
    async_: bool = Field(
        default=False,
        validation_alias="async",
        serialization_alias="async",
        description="Run asynchronously without blocking",
    )


class PromptHookConfig(BaseHookConfig):
    """Prompt hook configuration - uses LLM for intelligent decision making."""

    model_config = {"populate_by_name": True}

    type: Literal[HookType.PROMPT] = HookType.PROMPT
    prompt: str = Field(description="Prompt template for LLM decision")
    system_prompt: str | None = Field(
        default=None, description="Optional system prompt override"
    )
    model: str | None = Field(
        default=None, description="Model to use (defaults to session model)"
    )
    temperature: float = Field(default=0.1, ge=0.0, le=2.0, description="Sampling temperature")


class AgentHookConfig(BaseHookConfig):
    """Agent hook configuration - spawns a subagent for complex validation."""

    model_config = {"populate_by_name": True}

    type: Literal[HookType.AGENT] = HookType.AGENT
    task: str = Field(description="Task description for the subagent")
    agent_file: str | None = Field(
        default=None, description="Custom agent spec file (defaults to built-in validator)"
    )
    timeout: int = Field(
        default=120000, ge=1000, le=600000, description="Timeout in milliseconds (default 2 min)"
    )


HookConfig = CommandHookConfig | PromptHookConfig | AgentHookConfig


class HooksConfig(BaseModel):
    """Hooks configuration container."""

    session_start: list[HookConfig] = Field(default_factory=list)
    session_end: list[HookConfig] = Field(default_factory=list)
    before_agent: list[HookConfig] = Field(default_factory=list)
    after_agent: list[HookConfig] = Field(default_factory=list)
    before_tool: list[HookConfig] = Field(default_factory=list)
    after_tool: list[HookConfig] = Field(default_factory=list)
    after_tool_failure: list[HookConfig] = Field(default_factory=list)
    subagent_start: list[HookConfig] = Field(default_factory=list)
    subagent_stop: list[HookConfig] = Field(default_factory=list)
    pre_compact: list[HookConfig] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_hooks(self) -> HooksConfig:
        """Auto-assign names to unnamed hooks."""
        for field_name, hooks in self:
            for i, hook in enumerate(hooks):
                if hook.name is None:
                    hook.name = f"{field_name}_{i}"
        return self

"""Data models for Agent Hooks."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class HookDecision(str, Enum):
    """Hook execution decision."""

    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


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

    # Stop/Completion hooks (Quality Gate)
    BEFORE_STOP = "before_stop"


class HookType(str, Enum):
    """Hook implementation types."""

    COMMAND = "command"


@dataclass
class HookMatcher:
    """Matcher for filtering hook execution."""

    tool: Optional[str] = None
    pattern: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {}
        if self.tool is not None:
            result["tool"] = self.tool
        if self.pattern is not None:
            result["pattern"] = self.pattern
        return result


@dataclass
class HookProperties:
    """Properties parsed from a hook's HOOK.md frontmatter.

    Attributes:
        name: Hook name in kebab-case (required)
        description: What the hook does and when it triggers (required)
        trigger: Event type that triggers the hook (required)
        matcher: Filter conditions for tool-related triggers (optional)
        timeout: Timeout in milliseconds (default: 30000)
        async_: Whether to run asynchronously without blocking (default: False)
        priority: Execution priority, higher runs first (default: 100)
        metadata: Additional key-value metadata (optional)
    """

    name: str
    description: str
    trigger: HookEventType
    matcher: Optional[HookMatcher] = None
    timeout: int = 30000
    async_: bool = False
    priority: int = 100
    metadata: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {
            "name": self.name,
            "description": self.description,
            "trigger": self.trigger.value,
            "timeout": self.timeout,
            "async": self.async_,
            "priority": self.priority,
        }
        if self.matcher is not None:
            result["matcher"] = self.matcher.to_dict()
        if self.metadata:
            result["metadata"] = self.metadata
        return result


@dataclass
class HookValidationResult:
    """Result of hook validation."""

    valid: bool
    errors: list[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return self.valid


@dataclass
class HookOutput:
    """Hook execution output."""

    decision: HookDecision
    reason: Optional[str] = None
    modified_input: Optional[dict[str, Any]] = None
    additional_context: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {"decision": self.decision.value}
        if self.reason is not None:
            result["reason"] = self.reason
        if self.modified_input is not None:
            result["modified_input"] = self.modified_input
        if self.additional_context is not None:
            result["additional_context"] = self.additional_context
        return result

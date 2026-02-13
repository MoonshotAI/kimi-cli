from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class HookDecision(str, Enum):
    """Hook execution decision."""

    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


@dataclass(frozen=True, slots=True, kw_only=True)
class HookEvent:
    """Base hook event context."""

    event_type: str
    timestamp: datetime
    session_id: str
    work_dir: str
    context: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True, kw_only=True)
class ToolHookEvent(HookEvent):
    """Tool-specific hook event."""

    tool_name: str
    tool_input: dict[str, Any]
    tool_use_id: str | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class SubagentHookEvent(HookEvent):
    """Subagent-specific hook event."""

    subagent_name: str
    subagent_type: str | None = None
    task_description: str | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class SessionStartHookEvent(HookEvent):
    """Session start hook event."""

    model: str | None = None
    args: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True, kw_only=True)
class SessionEndHookEvent(HookEvent):
    """Session end hook event."""

    duration_seconds: int = 0
    total_steps: int = 0
    exit_reason: str = "user_exit"


@dataclass(frozen=True, slots=True, kw_only=True)
class HookResult:
    """Result of hook execution."""

    success: bool
    hook_name: str
    hook_type: str
    duration_ms: int
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    # Decision fields
    decision: HookDecision = HookDecision.ALLOW
    reason: str | None = None
    modified_input: dict[str, Any] | None = None
    additional_context: str | None = None

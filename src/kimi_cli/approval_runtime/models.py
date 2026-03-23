from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal

from kimi_cli.wire.types import DisplayBlock

type ApprovalResponseKind = Literal["approve", "approve_for_session", "reject"]
type ApprovalSourceKind = Literal["foreground_turn", "background_agent"]
type ApprovalStatus = Literal["pending", "resolved", "cancelled"]
type ApprovalRuntimeEventKind = Literal["request_created", "request_resolved"]


@dataclass(frozen=True, slots=True, kw_only=True)
class ApprovalSource:
    kind: ApprovalSourceKind
    id: str
    agent_id: str | None = None
    subagent_type: str | None = None


@dataclass(slots=True, kw_only=True)
class ApprovalRequestRecord:
    id: str
    tool_call_id: str
    sender: str
    action: str
    description: str
    display: list[DisplayBlock]
    source: ApprovalSource
    created_at: float = field(default_factory=time.time)
    status: ApprovalStatus = "pending"
    resolved_at: float | None = None
    response: ApprovalResponseKind | None = None
    feedback: str = ""


@dataclass(frozen=True, slots=True, kw_only=True)
class ApprovalRuntimeEvent:
    kind: ApprovalRuntimeEventKind
    request: ApprovalRequestRecord

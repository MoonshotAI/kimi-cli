from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

type ToolPolicyMode = Literal["inherit", "allowlist"]
type SubagentStatus = Literal[
    "idle",
    "running_foreground",
    "running_background",
    "completed",
    "failed",
    "killed",
]


@dataclass(frozen=True, slots=True, kw_only=True)
class ToolPolicy:
    mode: ToolPolicyMode
    tools: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True, kw_only=True)
class AgentTypeDefinition:
    name: str
    description: str
    agent_file: Path
    when_to_use: str = ""
    default_model: str | None = None
    tool_policy: ToolPolicy = field(default_factory=lambda: ToolPolicy(mode="inherit"))
    supports_background: bool = True


@dataclass(frozen=True, slots=True, kw_only=True)
class AgentLaunchSpec:
    agent_id: str
    subagent_type: str
    model_override: str | None
    effective_model: str | None
    work_dir: str | None = None  # Optional working directory override for subagent
    created_at: float = field(default_factory=time.time)


@dataclass(frozen=True, slots=True, kw_only=True)
class AgentInstanceRecord:
    agent_id: str
    subagent_type: str
    status: SubagentStatus
    description: str
    created_at: float
    updated_at: float
    last_task_id: str | None
    launch_spec: AgentLaunchSpec

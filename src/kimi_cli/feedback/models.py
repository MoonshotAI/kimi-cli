from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class SystemInfo(BaseModel):
    os_name: str
    os_version: str
    os_release: str
    os_arch: str
    python_version: str
    kimi_cli_version: str
    agent_spec_versions: list[str]
    wire_protocol_version: str
    device_id: str
    locale: str | None = None
    terminal: str | None = None
    shell: str | None = None


class InstallInfo(BaseModel):
    install_path: str | None = None
    install_method: str
    executable_path: str
    kimi_bin_path: str | None = None


class SessionSummary(BaseModel):
    session_id: str
    title: str
    message_count: int
    token_count: int
    work_dir: str


class ErrorInfo(BaseModel):
    last_error: str | None = None
    recent_exceptions: list[str] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]


class ChatMessage(BaseModel):
    role: str
    content: str
    tool_calls: list[str] | None = None


class ChatSummary(BaseModel):
    total_count: int = 0
    messages: list[ChatMessage] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]


class GitInfo(BaseModel):
    is_repo: bool = False
    branch: str | None = None
    commit: str | None = None
    dirty: bool | None = None
    remote_url: str | None = None


class MCPServerSummary(BaseModel):
    name: str
    status: str
    tool_count: int
    tools: list[str] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]


class TokenUsageSummary(BaseModel):
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cache_read_tokens: int = 0
    total_cache_creation_tokens: int = 0
    context_usage_pct: float = 0.0
    max_context_size: int = 0


class ActiveModelInfo(BaseModel):
    model_name: str
    provider_type: str
    provider_name: str
    thinking_enabled: bool | None = None
    max_context_size: int = 0
    capabilities: list[str] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]


class ExecutionSummary(BaseModel):
    total_turns: int = 0
    total_steps: int = 0
    max_steps_in_turn: int = 0
    compaction_count: int = 0
    checkpoint_count: int = 0
    session_duration_seconds: float | None = None


class ToolError(BaseModel):
    tool_name: str
    error_message: str


class ToolExecutionSummary(BaseModel):
    total_tool_calls: int = 0
    tool_call_counts: dict[str, int] = Field(default_factory=dict)
    tool_failures: int = 0
    tool_rejections: int = 0
    failed_tool_names: list[str] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    recent_tool_errors: list[ToolError] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]


class ApprovalState(BaseModel):
    yolo_mode: bool = False
    auto_approved_actions: list[str] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    total_approval_requests: int = 0


class AgentContext(BaseModel):
    discovered_skills: list[str] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    agents_md_present: bool = False
    subagent_count: int = 0


class ProjectContext(BaseModel):
    project_markers: list[str] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    git_tracked_file_count: int | None = None


class Phase1Request(BaseModel):
    schema_version: str = "1"
    timestamp: str
    source: str = "cli"
    user_message: str = ""
    system_info: SystemInfo
    install_info: InstallInfo
    config_redacted: dict[str, Any]
    session_summary: SessionSummary | None = None
    error_info: ErrorInfo = Field(default_factory=ErrorInfo)
    chat_summary: ChatSummary | None = None
    git_info: GitInfo | None = None
    mcp_servers: list[MCPServerSummary] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    env_vars: dict[str, str | None] = Field(default_factory=dict)
    token_usage_summary: TokenUsageSummary | None = None
    active_model: ActiveModelInfo | None = None
    execution_summary: ExecutionSummary | None = None
    tool_summary: ToolExecutionSummary | None = None
    approval_state: ApprovalState | None = None
    agent_context: AgentContext | None = None
    project_context: ProjectContext | None = None


class Phase1Response(BaseModel):
    report_id: str
    message: str | None = None

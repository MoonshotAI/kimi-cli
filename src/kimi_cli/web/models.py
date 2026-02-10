"""Kimi Code CLI Web UI data models."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

SessionState = Literal["stopped", "idle", "busy", "restarting", "error"]


class SessionStatus(BaseModel):
    """Runtime status of a web session."""

    session_id: UUID = Field(..., description="Session unique ID")
    state: SessionState = Field(..., description="Current session state")
    seq: int = Field(..., description="Monotonic sequence number")
    worker_id: str | None = Field(default=None, description="Worker instance ID")
    reason: str | None = Field(default=None, description="Reason for the state transition")
    detail: str | None = Field(default=None, description="Additional detail for debugging")
    updated_at: datetime = Field(..., description="Timestamp for this state")


class SessionNoticePayload(BaseModel):
    """Payload for session notice events."""

    text: str = Field(..., description="Display text for the notice")
    kind: Literal["restart"] = Field(default="restart", description="Notice type")
    reason: str | None = Field(default=None, description="Reason for the notice")
    restart_ms: int | None = Field(default=None, description="Restart duration in ms")


class SessionNoticeEvent(BaseModel):
    """Session notice event sent to frontend."""

    type: Literal["SessionNotice"] = Field(default="SessionNotice", description="Event type")
    payload: SessionNoticePayload


class GitFileDiff(BaseModel):
    """Single file git diff statistics"""

    path: str = Field(..., description="File path")
    additions: int = Field(..., description="Number of added lines")
    deletions: int = Field(..., description="Number of deleted lines")
    status: Literal["added", "modified", "deleted", "renamed"] = Field(
        ..., description="File change status"
    )


class GitDiffStats(BaseModel):
    """Git diff statistics for a work directory."""

    is_git_repo: bool = Field(..., description="Whether the directory is a git repo")
    has_changes: bool = Field(default=False, description="Whether there are uncommitted changes")
    total_additions: int = Field(default=0, description="Total added lines")
    total_deletions: int = Field(default=0, description="Total deleted lines")
    files: list[GitFileDiff] = Field(default=[], description="Per-file diff stats")
    error: str | None = Field(default=None, description="Error message if any")


class Session(BaseModel):
    """Web UI session metadata."""

    session_id: UUID = Field(..., description="Session unique ID")
    title: str = Field(..., description="Session title derived from kimi-cli history")
    last_updated: datetime = Field(..., description="Last updated timestamp")
    is_running: bool = Field(default=False, description="Whether the session is running")
    status: SessionStatus | None = Field(default=None, description="Session runtime status")
    work_dir: str | None = Field(default=None, description="Working directory for the session")
    session_dir: str | None = Field(default=None, description="Session directory path")
    archived: bool = Field(default=False, description="Whether the session is archived")


class UpdateSessionRequest(BaseModel):
    """Update session request."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    archived: bool | None = Field(default=None, description="Archive or unarchive the session")


class GenerateTitleRequest(BaseModel):
    """Generate title request.

    Parameters are optional - if not provided, the backend will read
    from wire.jsonl automatically.
    """

    user_message: str | None = None
    assistant_response: str | None = None


class GenerateTitleResponse(BaseModel):
    """Generate title response."""

    title: str

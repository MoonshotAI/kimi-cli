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


class Session(BaseModel):
    """Web UI session metadata."""

    session_id: UUID = Field(..., description="Session unique ID")
    title: str = Field(..., description="Session title derived from kimi-cli history")
    last_updated: datetime = Field(..., description="Last updated timestamp")
    is_running: bool = Field(default=False, description="Whether the session is running")
    status: SessionStatus | None = Field(default=None, description="Session runtime status")
    work_dir: str | None = Field(default=None, description="Working directory for the session")
    session_dir: str | None = Field(default=None, description="Session directory path")

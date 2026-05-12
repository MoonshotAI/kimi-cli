from __future__ import annotations

from pydantic import BaseModel, Field


class LoopTask(BaseModel):
    """A scheduled loop task."""

    id: str = Field(description="8-char hex task ID")
    cron: str = Field(description="5-field cron expression in local time")
    prompt: str = Field(description="The prompt to enqueue on fire")
    created_at: int = Field(description="Epoch ms when task was created")
    last_fired_at: int | None = Field(default=None, description="Epoch ms of last fire")
    recurring: bool = Field(default=False, description="True = reschedule after fire")
    permanent: bool = Field(default=False, description="True = exempt from auto-expiry")
    durable: bool = Field(default=False, description="Runtime flag: false = session-only")
    agent_id: str | None = Field(default=None, description="Route fires to specific subagent")


class JitterConfig(BaseModel):
    """Tunable parameters for load spreading."""

    recurring_frac: float = Field(default=0.1, description="Forward delay as fraction of interval")
    recurring_cap_ms: int = Field(default=15 * 60 * 1000, description="Max forward delay in ms")
    one_shot_max_ms: int = Field(default=90 * 1000, description="Max early lead for one-shots")
    one_shot_floor_ms: int = Field(default=0, description="Min early lead in ms")
    one_shot_minute_mod: int = Field(default=30, description="Which minute boundaries get jitter")
    recurring_max_age_ms: int = Field(
        default=7 * 24 * 60 * 60 * 1000, description="Auto-expiry for recurring tasks"
    )


class LoopConfig(BaseModel):
    """Configuration for the loop scheduler."""

    max_jobs: int = Field(default=50, description="Maximum concurrent scheduled tasks")
    jitter: JitterConfig = Field(default_factory=JitterConfig)
    enabled: bool = Field(default=True, description="Master kill-switch for scheduling")
    durable_enabled: bool = Field(default=True, description="Allow durable tasks")

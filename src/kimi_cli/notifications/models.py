from __future__ import annotations

import time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

type NotificationCategory = Literal["task", "agent", "system"]
type NotificationSeverity = Literal["info", "success", "warning", "error"]
type NotificationSink = Literal["llm", "wire", "shell"]
type NotificationDeliveryStatus = Literal["pending", "claimed", "acked"]


class NotificationEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: int = 1
    id: str
    category: NotificationCategory
    type: str
    source_kind: str
    source_id: str
    title: str
    body: str
    severity: NotificationSeverity = "info"
    created_at: float = Field(default_factory=time.time)
    payload: dict[str, Any] = Field(default_factory=dict)
    targets: list[NotificationSink] = Field(default_factory=lambda: ["llm", "wire", "shell"])
    dedupe_key: str | None = None


class NotificationSinkState(BaseModel):
    model_config = ConfigDict(extra="ignore")

    status: NotificationDeliveryStatus = "pending"
    claimed_at: float | None = None
    acked_at: float | None = None


class NotificationDelivery(BaseModel):
    model_config = ConfigDict(extra="ignore")

    sinks: dict[str, NotificationSinkState] = Field(default_factory=dict)


class NotificationView(BaseModel):
    model_config = ConfigDict(extra="ignore")

    event: NotificationEvent
    delivery: NotificationDelivery

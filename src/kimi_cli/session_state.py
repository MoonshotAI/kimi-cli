from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from kimi_cli.utils.io import atomic_json_write
from kimi_cli.utils.logging import logger

STATE_FILE_NAME = "state.json"


class ApprovalStateData(BaseModel):
    yolo: bool = False
    auto_approve_actions: set[str] = Field(default_factory=set)


class DynamicSubagentSpec(BaseModel):
    name: str
    system_prompt: str


def _default_dynamic_subagents() -> list[DynamicSubagentSpec]:
    return []


class SessionState(BaseModel):
    version: int = 1
    approval: ApprovalStateData = Field(default_factory=ApprovalStateData)
    dynamic_subagents: list[DynamicSubagentSpec] = Field(default_factory=_default_dynamic_subagents)


def load_session_state(session_dir: Path) -> SessionState:
    state_file = session_dir / STATE_FILE_NAME
    if not state_file.exists():
        return SessionState()
    try:
        with open(state_file, encoding="utf-8") as f:
            return SessionState.model_validate(json.load(f))
    except (json.JSONDecodeError, ValidationError, UnicodeDecodeError):
        logger.warning("Corrupted state file, using defaults: {path}", path=state_file)
        return SessionState()


def save_session_state(state: SessionState, session_dir: Path) -> None:
    state_file = session_dir / STATE_FILE_NAME
    atomic_json_write(state.model_dump(mode="json"), state_file)

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from kimi_cli.utils.io import atomic_json_write
from kimi_cli.utils.logging import logger

STATE_FILE_NAME = "state.json"


class ApprovalStateData(BaseModel):
    yolo: bool = False
    auto_approve_actions: set[str] = Field(default_factory=set)


class TodoItemState(BaseModel):
    """A single todo item stored in session or subagent state."""

    title: str
    status: Literal["pending", "in_progress", "done"]


class SessionState(BaseModel):
    version: int = 1
    approval: ApprovalStateData = Field(default_factory=ApprovalStateData)
    additional_dirs: list[str] = Field(default_factory=list)
    custom_title: str | None = None
    title_generated: bool = False
    title_generate_attempts: int = 0
    plan_mode: bool = False
    plan_session_id: str | None = None
    plan_slug: str | None = None
    # Archive state (previously in metadata.json)
    wire_mtime: float | None = None
    archived: bool = False
    archived_at: float | None = None
    auto_archive_exempt: bool = False
    # Todo list state
    todos: list[TodoItemState] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    # Worktree state
    worktree_path: str | None = None
    """Absolute path to the git worktree directory, if this session runs in one."""
    parent_repo_path: str | None = None
    """Absolute path to the parent git repository root, if this session runs in a worktree."""


_LEGACY_METADATA_FILENAME = "metadata.json"


def _migrate_legacy_metadata(session_dir: Path, state: SessionState) -> str:
    """Migrate fields from legacy metadata.json into SessionState.

    Returns:
        "migrated" - fields were merged into state, caller should save and delete legacy file
        "no_change" - legacy file parsed but no fields needed, caller can delete legacy file
        "skip" - legacy file missing or unreadable, caller should not touch it
    """
    metadata_file = session_dir / _LEGACY_METADATA_FILENAME
    if not metadata_file.exists():
        return "skip"
    try:
        data = json.loads(metadata_file.read_text(encoding="utf-8"))
    except Exception:
        # Leave the file intact for future retry — it may be temporarily unreadable
        return "skip"

    changed = False

    # Migrate title fields (only if state has defaults)
    if state.custom_title is None and data.get("title") and data["title"] != "Untitled":
        state.custom_title = data["title"]
        changed = True
    if not state.title_generated and data.get("title_generated"):
        state.title_generated = True
        changed = True
    if state.title_generate_attempts == 0 and data.get("title_generate_attempts", 0) > 0:
        state.title_generate_attempts = data["title_generate_attempts"]
        changed = True

    # Migrate archive fields
    if not state.archived and data.get("archived"):
        state.archived = True
        changed = True
    if state.archived_at is None and data.get("archived_at") is not None:
        state.archived_at = data["archived_at"]
        changed = True
    if not state.auto_archive_exempt and data.get("auto_archive_exempt"):
        state.auto_archive_exempt = True
        changed = True

    # Migrate wire_mtime
    if state.wire_mtime is None and data.get("wire_mtime") is not None:
        state.wire_mtime = data["wire_mtime"]
        changed = True

    return "migrated" if changed else "no_change"


def load_session_state(session_dir: Path) -> SessionState:
    state_file = session_dir / STATE_FILE_NAME
    if not state_file.exists():
        state = SessionState()
    else:
        try:
            with open(state_file, encoding="utf-8") as f:
                state = SessionState.model_validate(json.load(f))
        except (json.JSONDecodeError, ValidationError, UnicodeDecodeError) as e:
            logger.warning("Corrupted state file, using defaults: {path}", path=state_file)
            from kimi_cli.telemetry import track

            track("session_load_failed", reason=type(e).__name__)
            state = SessionState()

    # One-time migration from legacy metadata.json (best-effort)
    migration = _migrate_legacy_metadata(session_dir, state)
    if migration in ("migrated", "no_change"):
        try:
            if migration == "migrated":
                save_session_state(state, session_dir)
            (session_dir / _LEGACY_METADATA_FILENAME).unlink(missing_ok=True)
        except OSError:
            logger.warning(
                "Failed to persist migration for {path}, will retry next load",
                path=session_dir,
            )

    return state


def save_session_state(state: SessionState, session_dir: Path) -> None:
    state_file = session_dir / STATE_FILE_NAME
    atomic_json_write(state.model_dump(mode="json"), state_file)

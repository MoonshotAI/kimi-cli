from typing import Literal

from kosong.tooling import DisplayBlock
from pydantic import BaseModel


class DiffDisplayBlock(DisplayBlock):
    """Display block describing a file diff."""

    type: str = "diff"
    path: str
    old_text: str
    new_text: str
    old_start: int = 1
    new_start: int = 1
    is_summary: bool = False


class TodoDisplayItem(BaseModel):
    title: str
    status: Literal["pending", "in_progress", "done"]


class TodoDisplayBlock(DisplayBlock):
    """Display block describing a todo list update."""

    type: str = "todo"
    items: list[TodoDisplayItem]


class ShellDisplayBlock(DisplayBlock):
    """Display block describing a shell command."""

    type: str = "shell"
    language: str
    command: str


class BackgroundTaskDisplayBlock(DisplayBlock):
    """Display block describing a background task."""

    type: str = "background_task"
    task_id: str
    kind: str
    status: str
    description: str

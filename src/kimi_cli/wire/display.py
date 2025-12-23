from __future__ import annotations

from typing import Literal

from kosong.tooling import DisplayBlock
from pydantic import BaseModel

__all__ = [
    "DisplayBlock",  # re-export for convenience
    "DiffDisplayBlock",
    "TodoDisplayBlock",
    "TodoDisplayItem",
]


class DiffDisplayBlock(DisplayBlock):
    """Display block describing a file diff."""

    type: str = "diff"
    path: str
    old_text: str | None = None
    new_text: str


class TodoDisplayItem(BaseModel):
    title: str
    status: Literal["pending", "in_progress", "done"]


class TodoDisplayBlock(DisplayBlock):
    """Display block describing a todo list update."""

    type: str = "todo"
    items: list[TodoDisplayItem]

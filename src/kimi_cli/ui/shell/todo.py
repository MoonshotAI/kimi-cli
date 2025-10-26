from __future__ import annotations

# Simple in-memory storage for the current session's TODO list
# Updated when SetTodoList tool returns successfully.

_todo_text: str | None = None


def set_todo(text: str) -> None:
    global _todo_text
    _todo_text = text


def get_todo() -> str | None:
    return _todo_text

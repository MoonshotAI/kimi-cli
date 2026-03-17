from __future__ import annotations

import secrets

from .models import TaskKind

_TASK_ID_PREFIXES: dict[TaskKind, str] = {
    "bash": "b",
    "agent": "a",
}
_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


def generate_task_id(kind: TaskKind) -> str:
    prefix = _TASK_ID_PREFIXES[kind]
    suffix = "".join(secrets.choice(_ALPHABET) for _ in range(8))
    return f"{prefix}{suffix}"

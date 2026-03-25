from __future__ import annotations

import re
from collections.abc import Sequence
from typing import TYPE_CHECKING

from kosong.message import Message

from kimi_cli.wire.types import TextPart

from .models import NotificationView

if TYPE_CHECKING:
    from kimi_cli.soul.agent import Runtime

_NOTIFICATION_ID_RE = re.compile(r'<notification id="([^"]+)"')


def build_notification_message(view: NotificationView, runtime: Runtime) -> Message:
    event = view.event
    lines = [
        (
            f'<notification id="{event.id}" category="{event.category}" '
            f'type="{event.type}" source_kind="{event.source_kind}" source_id="{event.source_id}">'
        ),
        f"Title: {event.title}",
        f"Severity: {event.severity}",
        event.body,
    ]

    if event.category == "task" and event.source_kind == "background_task":
        task_view = runtime.background_tasks.get_task(event.source_id)
        if task_view is not None:
            tail = runtime.background_tasks.tail_output(
                task_view.spec.id,
                max_bytes=runtime.config.background.notification_tail_chars,
                max_lines=runtime.config.background.notification_tail_lines,
            )
            lines.extend(
                [
                    "<task-notification>",
                    f"Task ID: {task_view.spec.id}",
                    f"Task Type: {task_view.spec.kind}",
                    f"Description: {task_view.spec.description}",
                    f"Status: {task_view.runtime.status}",
                ]
            )
            if task_view.runtime.exit_code is not None:
                lines.append(f"Exit code: {task_view.runtime.exit_code}")
            if task_view.runtime.failure_reason:
                lines.append(f"Failure reason: {task_view.runtime.failure_reason}")
            if tail:
                lines.extend(["Output tail:", tail])
            lines.append("</task-notification>")

    lines.append("</notification>")
    return Message(role="user", content=[TextPart(text="\n".join(lines))])


def extract_notification_ids(history: Sequence[Message]) -> set[str]:
    ids: set[str] = set()
    for message in history:
        if message.role != "user":
            continue
        for part in message.content:
            if not isinstance(part, TextPart):
                continue
            for match in _NOTIFICATION_ID_RE.finditer(part.text):
                ids.add(match.group(1))
    return ids


def is_notification_message(message: Message) -> bool:
    if message.role != "user" or len(message.content) != 1:
        return False
    part = message.content[0]
    return isinstance(part, TextPart) and part.text.lstrip().startswith("<notification ")

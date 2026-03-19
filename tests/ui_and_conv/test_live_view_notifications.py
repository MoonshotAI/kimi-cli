from __future__ import annotations

from rich.console import Console

from kimi_cli.ui.shell.console import console as shell_console
from kimi_cli.ui.shell.visualize import _LiveView
from kimi_cli.wire.types import Notification, StatusUpdate


def _render(renderable) -> str:
    console = Console(width=100, record=True, highlight=False)
    console.print(renderable)
    return console.export_text()


def _notification(index: int = 1) -> Notification:
    return Notification(
        id=f"n{index:07d}",
        category="task",
        type="task.completed",
        source_kind="background_task",
        source_id=f"b{index:07d}",
        title=f"Background task completed: build project {index}",
        body=(f"Task ID: b{index:07d}\nStatus: completed\nDescription: build project {index}"),
        severity="success",
        created_at=123.456,
        payload={"task_id": f"b{index:07d}"},
    )


def test_live_view_renders_notification_block():
    view = _LiveView(StatusUpdate())

    view.dispatch_wire_message(_notification())

    rendered = _render(view.compose())
    assert "Background task completed: build project 1" in rendered
    assert "Task ID: b0000001" in rendered
    assert "Status: completed" in rendered
    assert "..." in rendered


def test_cleanup_flushes_notifications_to_terminal_history(monkeypatch):
    view = _LiveView(StatusUpdate())
    view.dispatch_wire_message(_notification())

    printed = []
    monkeypatch.setattr(shell_console, "print", lambda *args, **kwargs: printed.extend(args))

    view.cleanup(is_interrupt=False)

    assert not view._notification_blocks
    assert not view._live_notification_blocks
    assert printed
    rendered = _render(printed[0])
    assert "Background task completed: build project 1" in rendered
    assert "Task ID: b0000001" in rendered


def test_cleanup_flushes_all_notifications_even_when_live_view_shows_only_latest_four(monkeypatch):
    view = _LiveView(StatusUpdate())
    for index in range(1, 6):
        view.dispatch_wire_message(_notification(index))

    live_rendered = _render(view.compose())
    assert "Background task completed: build project 1" not in live_rendered
    for index in range(2, 6):
        assert f"Background task completed: build project {index}" in live_rendered

    printed = []
    monkeypatch.setattr(shell_console, "print", lambda *args, **kwargs: printed.extend(args))

    view.cleanup(is_interrupt=False)

    assert len(printed) == 5
    rendered = "\n".join(_render(item) for item in printed)
    for index in range(1, 6):
        assert f"Background task completed: build project {index}" in rendered

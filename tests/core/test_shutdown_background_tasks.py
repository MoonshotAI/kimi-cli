"""Tests for ``KimiCLI.shutdown_background_tasks``.

On CLI exit (``/exit``, Ctrl+D, end of ``-p`` run), the user should see:

- a stderr headline naming the tasks about to be killed;
- one line per task (id + description) so they know what was terminated;
- an optional supplemental line if any worker is still alive after the
  grace period.

``keep_alive_on_exit=True`` disables the whole path (no stderr, no kill).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from kimi_cli.app import KimiCLI


def _fake_view(
    task_id: str,
    description: str = "desc",
    *,
    status: str = "running",
) -> MagicMock:
    view = MagicMock()
    view.spec.id = task_id
    view.spec.description = description
    view.runtime.status = status
    return view


def _make_cli(
    *,
    keep_alive: bool,
    views: list[MagicMock],
    kill_grace_ms: int = 2000,
    kill_leaves_alive: bool = False,
) -> tuple[KimiCLI, MagicMock, dict]:
    """Build a KimiCLI stub exposing only what shutdown_background_tasks needs.

    ``kill_leaves_alive=True`` simulates workers that do not terminate inside
    the grace window — their status stays ``running`` after ``kill_all_active``.
    """
    manager = MagicMock()
    state: dict = {"views": list(views), "killed": False}

    def _list_tasks(*, status=None, limit=None):
        return list(state["views"])

    manager.list_tasks = MagicMock(side_effect=_list_tasks)

    def _kill_all_active(*, reason: str = "Killed") -> list[str]:
        state["killed"] = True
        killed_ids: list[str] = []
        for v in state["views"]:
            if v.runtime.status != "running":
                continue
            killed_ids.append(v.spec.id)
            if not kill_leaves_alive:
                v.runtime.status = "killed"
        return killed_ids

    manager.kill_all_active = MagicMock(side_effect=_kill_all_active)
    manager.reconcile = MagicMock()

    runtime = MagicMock()
    runtime.config.background.keep_alive_on_exit = keep_alive
    runtime.config.background.kill_grace_period_ms = kill_grace_ms
    runtime.background_tasks = manager

    cli = KimiCLI.__new__(KimiCLI)
    cli._soul = MagicMock()
    cli._runtime = runtime
    cli._env_overrides = {}

    return cli, manager, state


@pytest.mark.asyncio
async def test_shutdown_prints_notice_and_kills_when_active(capsys) -> None:
    views = [
        _fake_view("b-001", "deploy staging"),
        _fake_view("b-002", 'agent "fix failing tests"'),
    ]
    cli, manager, _ = _make_cli(keep_alive=False, views=views)

    sleep_calls: list[float] = []

    async def fake_sleep(duration):
        sleep_calls.append(duration)

    with patch("kimi_cli.app.asyncio.sleep", side_effect=fake_sleep):
        await cli.shutdown_background_tasks()

    # kill_all_active was called exactly once
    manager.kill_all_active.assert_called_once()

    captured = capsys.readouterr()
    err = captured.err

    # Headline names the count
    assert "2" in err and "background task" in err.lower()
    # Each task id and description appears
    assert "b-001" in err
    assert "deploy staging" in err
    assert "b-002" in err
    assert "fix failing tests" in err

    # Grace sleep happened with kill_grace_period_ms / 1000 = 2.0
    assert 2.0 in sleep_calls


@pytest.mark.asyncio
async def test_shutdown_skipped_when_keep_alive_on_exit(capsys) -> None:
    views = [_fake_view("b-001", "persistent watcher")]
    cli, manager, _ = _make_cli(keep_alive=True, views=views)

    async def fake_sleep(duration):
        pass

    with patch("kimi_cli.app.asyncio.sleep", side_effect=fake_sleep):
        await cli.shutdown_background_tasks()

    # keep_alive_on_exit=True → complete no-op
    manager.kill_all_active.assert_not_called()
    manager.list_tasks.assert_not_called()

    captured = capsys.readouterr()
    assert captured.err == ""


@pytest.mark.asyncio
async def test_shutdown_reports_survivors_after_grace(capsys) -> None:
    """If any worker is still running after the grace period, add a
    supplemental line so the user is not lied to about the kill."""
    views = [
        _fake_view("b-001", "stubborn watcher"),
        _fake_view("b-002", "quick task"),
    ]
    cli, manager, _ = _make_cli(
        keep_alive=False,
        views=views,
        kill_leaves_alive=True,  # Simulate workers that ignore SIGTERM
    )

    async def fake_sleep(duration):
        pass

    with patch("kimi_cli.app.asyncio.sleep", side_effect=fake_sleep):
        await cli.shutdown_background_tasks()

    captured = capsys.readouterr()
    assert "still alive" in captured.err
    # Survivor count (2) should appear
    assert "2" in captured.err


@pytest.mark.asyncio
async def test_shutdown_swallows_manager_exception(capsys) -> None:
    """CLI shutdown is not allowed to propagate exceptions to the top-level
    exit path.  If ``list_tasks`` or ``reconcile`` raises (disk IO error,
    permission denied, corrupted store), ``shutdown_background_tasks`` must
    log a warning and return cleanly so the user sees the normal exit code
    instead of a traceback."""
    views = [_fake_view("b-001", "x")]
    cli, manager, _ = _make_cli(keep_alive=False, views=views)

    # Simulate a disk IO error from the store layer.
    manager.list_tasks.side_effect = OSError("disk read error")

    async def fake_sleep(duration):
        pass

    # Must NOT raise.
    with patch("kimi_cli.app.asyncio.sleep", side_effect=fake_sleep):
        await cli.shutdown_background_tasks()


@pytest.mark.asyncio
async def test_shutdown_no_notice_when_no_active_tasks(capsys) -> None:
    """With no active bg tasks, there is nothing to announce or kill."""
    cli, manager, _ = _make_cli(keep_alive=False, views=[])

    async def fake_sleep(duration):
        pass

    with patch("kimi_cli.app.asyncio.sleep", side_effect=fake_sleep):
        await cli.shutdown_background_tasks()

    # No active tasks means no kill call (early return) and nothing on stderr.
    manager.kill_all_active.assert_not_called()
    captured = capsys.readouterr()
    assert captured.err == ""

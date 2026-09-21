"""Tests for ``KimiCLI.shutdown_background_tasks``.

On CLI exit (``/exit``, Ctrl+D, end of ``-p`` run), the user should see:

- a stderr headline naming the tasks about to be killed;
- one line per task (id + description) so they know what was terminated;
- an optional supplemental line if any worker is still alive after the
  grace period.

``keep_alive_on_exit=True`` disables the whole path (no stderr, no kill).
"""

from __future__ import annotations

import contextlib
import io
from unittest.mock import MagicMock, patch

import pytest

from kimi_cli.app import KimiCLI


def _fake_view(
    task_id: str,
    description: str = "desc",
    *,
    status: str = "running",
    kill_requested_at: float | None = None,
) -> MagicMock:
    view = MagicMock()
    view.spec.id = task_id
    view.spec.description = description
    view.runtime.status = status
    view.control.kill_requested_at = kill_requested_at
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
    the grace window — their status stays ``running`` after ``kill``.
    """
    manager = MagicMock()
    state: dict = {"views": list(views), "kill_calls": []}

    def _list_tasks(*, status=None, limit=None):
        return list(state["views"])

    manager.list_tasks = MagicMock(side_effect=_list_tasks)

    def _kill(task_id: str, *, reason: str = "Killed"):
        state["kill_calls"].append((task_id, reason))
        for v in state["views"]:
            if v.spec.id != task_id or v.runtime.status != "running":
                continue
            v.control.kill_requested_at = 1.0
            if not kill_leaves_alive:
                v.runtime.status = "killed"

    manager.kill = MagicMock(side_effect=_kill)

    def _kill_all_active(*, reason: str = "Killed") -> list[str]:
        killed_ids: list[str] = []
        for v in state["views"]:
            if v.runtime.status != "running":
                continue
            killed_ids.append(v.spec.id)
            _kill(v.spec.id, reason=reason)
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
    cli._bg_refresh_task = None

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

    # Each fresh active task was kill-requested once.
    kill_ids = sorted(call.args[0] for call in manager.kill.call_args_list)
    assert kill_ids == ["b-001", "b-002"]

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
    # Survivors here all have kill_requested_at set (shutdown just wrote it).
    # They shouldn't be labelled as leaks — that would contradict the
    # "Killing 2 background tasks" header.  Label them "still terminating"
    # so the user understands the worker is mid-shutdown.
    assert "still terminating" in captured.err
    assert "stop request failed" not in captured.err
    assert "2" in captured.err


@pytest.mark.asyncio
async def test_shutdown_writes_to_original_stderr_when_redirected(monkeypatch) -> None:
    """When stderr has been redirected to the logger via ``redirect_stderr_to_logger``,
    the kill notice must still reach the user's terminal.  ``sys.stderr.write``
    alone would silently send the notice into ``kimi.log`` (where fd=2 now
    points), leaving the user with zero feedback about what was killed.

    The fix uses ``open_original_stderr`` (same pattern as ``_emit_fatal_error``
    in ``cli/__init__.py`` and the shell subprocess wrapper in ``ui/shell``).
    """
    views = [
        _fake_view("b-001", "deploy staging"),
        _fake_view("b-002", "fix tests"),
    ]
    cli, manager, _ = _make_cli(keep_alive=False, views=views)

    captured = io.BytesIO()

    class _FakeOriginalStream:
        def write(self, data):
            captured.write(data)

        def flush(self):
            pass

    @contextlib.contextmanager
    def fake_open_original_stderr():
        yield _FakeOriginalStream()

    monkeypatch.setattr("kimi_cli.app.open_original_stderr", fake_open_original_stderr)

    async def fake_sleep(duration):
        pass

    with patch("kimi_cli.app.asyncio.sleep", side_effect=fake_sleep):
        await cli.shutdown_background_tasks()

    output = captured.getvalue().decode("utf-8")
    assert "2" in output and "background task" in output.lower()
    assert "b-001" in output
    assert "deploy staging" in output
    assert "b-002" in output


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
async def test_shutdown_skips_already_kill_requested_tasks(capsys) -> None:
    """When the ``--print`` timeout path has just kill-requested some tasks
    (writing ``print_wait_timeout`` to ``control.kill_reason``), the outer
    CLI shutdown must not:

    1. Re-announce them on stderr (user already saw "timed out ... killed N").
    2. Re-kill them with ``reason="CLI session ended"`` — that would
       overwrite the more specific ``print_wait_timeout`` reason on disk.

    Shutdown should still reconcile and honour the grace period so those
    workers can terminate cleanly.
    """
    views = [
        # Already kill-requested by the --print timeout path (SIGTERM sent,
        # worker still writing terminal state).
        _fake_view("b-001", "from print timeout", kill_requested_at=1234.5),
        # Fresh, not yet kill-requested.
        _fake_view("b-002", "still active"),
    ]
    cli, manager, state = _make_cli(keep_alive=False, views=views)

    async def fake_sleep(duration):
        pass

    with patch("kimi_cli.app.asyncio.sleep", side_effect=fake_sleep):
        await cli.shutdown_background_tasks()

    # Only the fresh task (b-002) was kill-requested by shutdown.
    kill_ids = [tid for (tid, _reason) in state["kill_calls"]]
    assert kill_ids == ["b-002"], f"expected only b-002 to be killed, got {kill_ids}"

    captured = capsys.readouterr()
    # The announcement should only name the fresh task, not the one already killed
    # by --print timeout.
    assert "b-002" in captured.err
    assert "still active" in captured.err
    assert "b-001" not in captured.err
    assert "from print timeout" not in captured.err
    # Headline reflects fresh kill count (1), not total active (2).
    assert "Killing 1 background task" in captured.err


@pytest.mark.asyncio
async def test_shutdown_survivors_from_print_timeout_labelled_terminating(capsys) -> None:
    """When Print's timeout path already kill-requested the tasks and the
    workers haven't finished terminating by the time shutdown's grace
    expires, the survivor notice must say ``still terminating`` — not
    ``still alive``, which would contradict the ``killed N`` message the
    user saw moments earlier from the Print timeout path."""
    views = [
        _fake_view("b-001", "slow worker", kill_requested_at=1234.5),
    ]
    cli, manager, _ = _make_cli(keep_alive=False, views=views)

    async def fake_sleep(duration):
        pass

    with patch("kimi_cli.app.asyncio.sleep", side_effect=fake_sleep):
        await cli.shutdown_background_tasks()

    captured = capsys.readouterr()
    assert "still terminating" in captured.err
    assert "still alive" not in captured.err


@pytest.mark.asyncio
async def test_shutdown_survivors_from_failed_kill_labelled_alive(capsys) -> None:
    """Survivors that were NOT successfully kill-requested (kill raised, so
    control.kill_requested_at stayed None) are genuinely leaking and must
    be called out as ``still alive`` — the user sees the system failed to
    initiate termination."""
    views = [_fake_view("b-001", "leak")]
    cli, manager, state = _make_cli(keep_alive=False, views=views)

    # Simulate kill() raising — control.kill_requested_at stays None,
    # runtime.status stays "running".
    def _kill_raises(task_id, *, reason="Killed"):
        state["kill_calls"].append((task_id, reason))
        raise OSError("simulated kill failure")

    manager.kill.side_effect = _kill_raises

    async def fake_sleep(duration):
        pass

    with patch("kimi_cli.app.asyncio.sleep", side_effect=fake_sleep):
        await cli.shutdown_background_tasks()

    captured = capsys.readouterr()
    # Leaking task: never got kill-requested → "stop request failed".
    assert "stop request failed" in captured.err
    assert "still terminating" not in captured.err


@pytest.mark.asyncio
async def test_shutdown_with_only_already_killed_tasks_stays_quiet(capsys) -> None:
    """If every active task has already been kill-requested (by --print
    timeout), shutdown should not print a misleading second ``Killing N``
    notice.  It should only reconcile / grace-wait silently."""
    views = [
        _fake_view("b-001", "already", kill_requested_at=1234.5),
        _fake_view("b-002", "already too", kill_requested_at=1234.5),
    ]
    cli, manager, state = _make_cli(keep_alive=False, views=views)

    async def fake_sleep(duration):
        pass

    with patch("kimi_cli.app.asyncio.sleep", side_effect=fake_sleep):
        await cli.shutdown_background_tasks()

    # No kill calls, no stderr "Killing" header (user already saw the
    # --print timeout notice).
    assert state["kill_calls"] == []
    captured = capsys.readouterr()
    assert "Killing" not in captured.err
    # Reconcile still runs so disk state is flushed.
    manager.reconcile.assert_called()


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

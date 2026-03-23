"""Tests for /loop slash commands."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import pytest_asyncio
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell import slash as shell_slash
from kimi_cli.ui.shell.loop_scheduler import LoopScheduler, LoopTask, get_loop_scheduler


def _make_shell_app(runtime: Runtime, tmp_path: Path) -> SimpleNamespace:
    """Create a mock shell app with a KimiSoul."""
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    shell = SimpleNamespace(soul=soul)
    return shell


# -----------------------------------------------------------------------------
# Command Registration
# -----------------------------------------------------------------------------


def test_loop_command_registered() -> None:
    """/loop should be registered in shell registry."""
    assert shell_slash.registry.find_command("loop") is not None


def test_loop_cancel_command_registered() -> None:
    """/loop-cancel should be registered with alias."""
    cmd = shell_slash.registry.find_command("loop-cancel")
    assert cmd is not None
    # Check alias
    assert shell_slash.registry.find_command("loop-cancel") is cmd


def test_loop_list_command_registered() -> None:
    """/loop-list should be registered with alias."""
    cmd = shell_slash.registry.find_command("loop-list")
    assert cmd is not None
    # Check alias
    assert shell_slash.registry.find_command("loop-list") is cmd


# -----------------------------------------------------------------------------
# LoopScheduler - Interval Parsing
# -----------------------------------------------------------------------------


class TestLoopSchedulerIntervalParsing:
    """Test interval string parsing."""

    @pytest.fixture
    def scheduler(self, tmp_path: Path) -> LoopScheduler:
        """Create a LoopScheduler with a mock shell."""
        shell = Mock()
        return LoopScheduler(shell)

    def test_parse_seconds(self, scheduler: LoopScheduler) -> None:
        """Parse interval in seconds."""
        assert scheduler._parse_interval("30s") == 60.0  # minimum is 60s
        assert scheduler._parse_interval("90s") == 90.0

    def test_parse_minutes(self, scheduler: LoopScheduler) -> None:
        """Parse interval in minutes."""
        assert scheduler._parse_interval("5m") == 300.0
        assert scheduler._parse_interval("1.5m") == 90.0

    def test_parse_hours(self, scheduler: LoopScheduler) -> None:
        """Parse interval in hours."""
        assert scheduler._parse_interval("2h") == 7200.0
        assert scheduler._parse_interval("0.5h") == 1800.0

    def test_parse_days(self, scheduler: LoopScheduler) -> None:
        """Parse interval in days."""
        assert scheduler._parse_interval("1d") == 86400.0

    def test_parse_plain_number_as_minutes(self, scheduler: LoopScheduler) -> None:
        """Plain number is treated as minutes."""
        assert scheduler._parse_interval("5") == 300.0
        assert scheduler._parse_interval("0.5") == 60.0  # minimum 60s

    def test_parse_with_whitespace(self, scheduler: LoopScheduler) -> None:
        """Whitespace is handled correctly."""
        assert scheduler._parse_interval("  5m  ") == 300.0

    def test_parse_case_insensitive(self, scheduler: LoopScheduler) -> None:
        """Unit suffix is case insensitive."""
        assert scheduler._parse_interval("5M") == 300.0
        assert scheduler._parse_interval("2H") == 7200.0

    def test_parse_invalid_format_raises(self, scheduler: LoopScheduler) -> None:
        """Invalid format raises ValueError."""
        with pytest.raises(ValueError, match="Invalid interval"):
            scheduler._parse_interval("invalid")
        with pytest.raises(ValueError, match="Invalid interval"):
            scheduler._parse_interval("5x")

    def test_parse_non_positive_raises(self, scheduler: LoopScheduler) -> None:
        """Non-positive interval raises ValueError."""
        with pytest.raises(ValueError):
            scheduler._parse_interval("0")
        with pytest.raises(ValueError):
            scheduler._parse_interval("-5")


# -----------------------------------------------------------------------------
# LoopScheduler - Task Management
# -----------------------------------------------------------------------------


class TestLoopSchedulerTaskManagement:
    """Test task creation, cancellation, and listing."""

    @pytest_asyncio.fixture
    async def scheduler(self, tmp_path: Path) -> LoopScheduler:
        """Create a LoopScheduler with a mock shell."""
        shell = Mock()
        future = asyncio.get_event_loop().create_future()
        future.set_result(None)
        shell.run_soul_command = Mock(return_value=future)
        return LoopScheduler(shell)

    @pytest.mark.asyncio
    async def test_create_task(self, scheduler: LoopScheduler) -> None:
        """Create a task successfully."""
        task = await scheduler.create_task("5m", "check emails")

        assert task.id.startswith("loop_")
        assert task.interval_s == 300.0
        assert task.prompt == "check emails"
        assert task.run_count == 0
        assert task.max_runs is None
        assert not task.cancelled

    @pytest.mark.asyncio
    async def test_create_task_with_max_runs(self, scheduler: LoopScheduler) -> None:
        """Create a task with maximum runs limit."""
        task = await scheduler.create_task("5m", "check emails", max_runs=5)

        assert task.max_runs == 5

    @pytest.mark.asyncio
    async def test_create_task_with_expiry(self, scheduler: LoopScheduler) -> None:
        """Create a task with custom expiry (in days)."""
        import time

        task = await scheduler.create_task("5m", "check emails", expires_in=1)

        # Task should expire in approximately 1 day
        expected_expiry = time.time() + 86400
        assert task.expires_at is not None
        assert abs(task.expires_at - expected_expiry) < 5  # within 5 seconds

    @pytest.mark.asyncio
    async def test_max_tasks_limit(self, scheduler: LoopScheduler) -> None:
        """Maximum number of tasks is enforced."""
        # Create max tasks
        for i in range(scheduler.MAX_TASKS):
            await scheduler.create_task("5m", f"task {i}")

        # Next creation should fail
        with pytest.raises(RuntimeError, match="Maximum number of loop tasks"):
            await scheduler.create_task("5m", "one too many")

    @pytest.mark.asyncio
    async def test_cancel_task(self, scheduler: LoopScheduler) -> None:
        """Cancel a task by ID."""
        task = await scheduler.create_task("5m", "check emails")

        result = await scheduler.cancel_task(task.id)

        assert result is True
        assert task.cancelled is True

    @pytest.mark.asyncio
    async def test_cancel_nonexistent_task(self, scheduler: LoopScheduler) -> None:
        """Cancel a non-existent task returns False."""
        result = await scheduler.cancel_task("loop_nonexistent")

        assert result is False

    @pytest.mark.asyncio
    async def test_cancel_all_tasks(self, scheduler: LoopScheduler) -> None:
        """Cancel all tasks returns count."""
        task1 = await scheduler.create_task("5m", "task 1")
        task2 = await scheduler.create_task("10m", "task 2")

        count = await scheduler.cancel_all_tasks()

        assert count == 2
        assert task1.cancelled is True
        assert task2.cancelled is True

    @pytest.mark.asyncio
    async def test_list_tasks(self, scheduler: LoopScheduler) -> None:
        """List all tasks."""
        task1 = await scheduler.create_task("5m", "task 1")
        task2 = await scheduler.create_task("10m", "task 2")

        tasks = scheduler.list_tasks()

        assert len(tasks) == 2
        assert tasks[0].id == task1.id
        assert tasks[1].id == task2.id

    @pytest.mark.asyncio
    async def test_list_active_tasks_only(self, scheduler: LoopScheduler) -> None:
        """List only active (non-complete) tasks."""
        task1 = await scheduler.create_task("5m", "task 1")
        task2 = await scheduler.create_task("10m", "task 2")
        await scheduler.cancel_task(task2.id)

        tasks = scheduler.list_tasks(active_only=True)

        assert len(tasks) == 1
        assert tasks[0].id == task1.id

    @pytest.mark.asyncio
    async def test_get_task(self, scheduler: LoopScheduler) -> None:
        """Get a specific task by ID."""
        task = await scheduler.create_task("5m", "check emails")

        found = scheduler.get_task(task.id)
        not_found = scheduler.get_task("nonexistent")

        assert found is task
        assert not_found is None


# -----------------------------------------------------------------------------
# LoopTask - State Management
# -----------------------------------------------------------------------------


class TestLoopTaskState:
    """Test LoopTask state properties."""

    def test_next_run_before_first_execution(self) -> None:
        """Next run is created_at before first execution."""
        task = LoopTask(
            id="loop_test",
            interval_s=300.0,
            prompt="test",
            created_at=1000.0,
            last_run_at=None,
        )

        assert task.next_run_at == 1000.0

    def test_next_run_after_execution(self) -> None:
        """Next run is last_run + interval after execution."""
        task = LoopTask(
            id="loop_test",
            interval_s=300.0,
            prompt="test",
            created_at=1000.0,
            last_run_at=1500.0,
        )

        assert task.next_run_at == 1800.0

    def test_is_complete_when_cancelled(self) -> None:
        """Task is complete when cancelled."""
        task = LoopTask(
            id="loop_test",
            interval_s=300.0,
            prompt="test",
            cancelled=True,
        )

        assert task.is_complete is True
        assert task.next_run_at is None

    def test_is_complete_when_max_runs_reached(self) -> None:
        """Task is complete when max_runs reached."""
        task = LoopTask(
            id="loop_test",
            interval_s=300.0,
            prompt="test",
            run_count=5,
            max_runs=5,
        )

        assert task.is_complete is True

    def test_is_complete_when_expired(self) -> None:
        """Task is complete when expired."""
        import time

        task = LoopTask(
            id="loop_test",
            interval_s=300.0,
            prompt="test",
            expires_at=time.time() - 1,  # Expired 1 second ago
        )

        assert task.is_complete is True
        assert task.is_expired is True

    def test_is_not_complete_when_active(self) -> None:
        """Task is not complete when active."""
        task = LoopTask(
            id="loop_test",
            interval_s=300.0,
            prompt="test",
            run_count=2,
            max_runs=5,
        )

        assert task.is_complete is False


# -----------------------------------------------------------------------------
# Slash Command Integration
# -----------------------------------------------------------------------------


class TestLoopSlashCommands:
    """Test slash command integration."""

    @pytest.mark.asyncio
    async def test_loop_command_no_args_shows_empty(
        self, runtime: Runtime, tmp_path: Path, monkeypatch
    ) -> None:
        """/loop with no args shows empty message when no tasks."""
        app = _make_shell_app(runtime, tmp_path)
        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)

        # Clear any existing scheduler
        from kimi_cli.ui.shell.loop_scheduler import _loop_schedulers

        _loop_schedulers.clear()

        await shell_slash.loop(app, "")  # type: ignore[arg-type]

        # Should show "No active loop tasks" message
        calls = print_mock.call_args_list
        assert any("No active loop tasks" in str(c) for c in calls)

    @pytest.mark.asyncio
    async def test_loop_command_creates_task(
        self, runtime: Runtime, tmp_path: Path, monkeypatch
    ) -> None:
        """/loop with interval and prompt creates a task."""
        app = _make_shell_app(runtime, tmp_path)
        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)

        # Clear any existing scheduler
        from kimi_cli.ui.shell.loop_scheduler import _loop_schedulers

        _loop_schedulers.clear()

        await shell_slash.loop(app, "5m check emails")  # type: ignore[arg-type]

        # Should show success message with task ID
        calls = print_mock.call_args_list
        assert any("Created loop task" in str(c) for c in calls)

    @pytest.mark.asyncio
    async def test_loop_command_invalid_interval(
        self, runtime: Runtime, tmp_path: Path, monkeypatch
    ) -> None:
        """/loop with invalid interval shows error."""
        app = _make_shell_app(runtime, tmp_path)
        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)

        # Clear any existing scheduler
        from kimi_cli.ui.shell.loop_scheduler import _loop_schedulers

        _loop_schedulers.clear()

        await shell_slash.loop(app, "invalid check emails")  # type: ignore[arg-type]

        # Should show error message
        calls = print_mock.call_args_list
        assert any("Invalid interval" in str(c) for c in calls)

    @pytest.mark.asyncio
    async def test_loop_command_missing_prompt(
        self, runtime: Runtime, tmp_path: Path, monkeypatch
    ) -> None:
        """/loop with only interval shows usage."""
        app = _make_shell_app(runtime, tmp_path)
        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)

        await shell_slash.loop(app, "5m")  # type: ignore[arg-type]

        # Should show usage message
        calls = print_mock.call_args_list
        assert any("Usage" in str(c) for c in calls)

    @pytest.mark.asyncio
    async def test_loop_cancel_no_args_shows_tasks(
        self, runtime: Runtime, tmp_path: Path, monkeypatch
    ) -> None:
        """/loop-cancel with no args shows active tasks."""
        app = _make_shell_app(runtime, tmp_path)
        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)

        # Clear any existing scheduler and create a task
        from kimi_cli.ui.shell.loop_scheduler import _loop_schedulers

        _loop_schedulers.clear()
        scheduler = get_loop_scheduler(app)  # type: ignore[arg-type]
        await scheduler.create_task("5m", "test task")

        await shell_slash.loop_cancel(app, "")  # type: ignore[arg-type]

        # Should cancel the single task
        calls = print_mock.call_args_list
        assert any("Cancelled" in str(c) for c in calls)

    def test_loop_list_shows_tasks(self, runtime: Runtime, tmp_path: Path, monkeypatch) -> None:
        """/loop-list shows all tasks."""
        app = _make_shell_app(runtime, tmp_path)
        print_mock = Mock()
        monkeypatch.setattr(shell_slash.console, "print", print_mock)

        # Clear any existing scheduler
        from kimi_cli.ui.shell.loop_scheduler import _loop_schedulers

        _loop_schedulers.clear()

        shell_slash.loop_list(app, "")  # type: ignore[arg-type]

        # Should show "No loop tasks" when empty
        calls = print_mock.call_args_list
        assert any("No loop tasks" in str(c) for c in calls)


# -----------------------------------------------------------------------------
# Scheduler Lifecycle
# -----------------------------------------------------------------------------


class TestSchedulerLifecycle:
    """Test scheduler startup and shutdown."""

    @pytest.mark.asyncio
    async def test_scheduler_starts_on_first_task(self, tmp_path: Path) -> None:
        """Scheduler starts when first task is created."""
        shell = Mock()
        future = asyncio.get_event_loop().create_future()
        future.set_result(None)
        shell.run_soul_command = Mock(return_value=future)
        scheduler = LoopScheduler(shell)

        assert scheduler._scheduler_task is None

        await scheduler.create_task("5m", "test")

        assert scheduler._scheduler_task is not None

    def test_scheduler_shutdown(self, tmp_path: Path) -> None:
        """Scheduler shuts down properly."""
        shell = Mock()
        scheduler = LoopScheduler(shell)

        # Mock the task
        mock_task = Mock()
        mock_task.done.return_value = False
        scheduler._scheduler_task = mock_task

        scheduler.shutdown()

        mock_task.cancel.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_loop_scheduler_creates_new(self, tmp_path: Path) -> None:
        """get_loop_scheduler creates new scheduler for new shell."""
        shell = Mock()

        # Clear existing schedulers
        from kimi_cli.ui.shell.loop_scheduler import _loop_schedulers

        _loop_schedulers.clear()

        scheduler = get_loop_scheduler(shell)

        assert isinstance(scheduler, LoopScheduler)
        assert scheduler._shell is shell

    @pytest.mark.asyncio
    async def test_remove_loop_scheduler(self, tmp_path: Path) -> None:
        """remove_loop_scheduler shuts down and removes scheduler."""
        shell = Mock()

        # Clear existing schedulers
        from kimi_cli.ui.shell.loop_scheduler import _loop_schedulers

        _loop_schedulers.clear()

        scheduler = get_loop_scheduler(shell)
        scheduler.shutdown = Mock()

        from kimi_cli.ui.shell.loop_scheduler import remove_loop_scheduler

        remove_loop_scheduler(shell)

        scheduler.shutdown.assert_called_once()
        assert id(shell) not in _loop_schedulers

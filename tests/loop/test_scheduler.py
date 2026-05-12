from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from kimi_cli.loop.models import JitterConfig, LoopConfig, LoopTask
from kimi_cli.loop.scheduler import (
    LoopScheduler,
    _compute_next_fire_at,
    _frac_from_id,
)

croniter = pytest.importorskip("croniter")


class TestFracFromId:
    def test_deterministic(self) -> None:
        assert _frac_from_id("abc123") == _frac_from_id("abc123")

    def test_in_range(self) -> None:
        assert 0.0 <= _frac_from_id("anyid") < 1.0

    def test_different_ids(self) -> None:
        # Very unlikely to collide for different IDs
        assert _frac_from_id("id1") != _frac_from_id("id2")


class TestComputeNextFireAt:
    def test_recurring_jitter_forward(self) -> None:
        task = LoopTask(
            id="test0001",
            cron="0 * * * *",  # every hour
            prompt="test",
            created_at=0,
            recurring=True,
        )
        cfg = JitterConfig(recurring_frac=0.1, recurring_cap_ms=60_000)
        # from 0, next hour is 3600000ms; jitter is fraction * 0.1 * 3600000, capped at 60000
        result = _compute_next_fire_at(task, 0, cfg)
        assert result is not None
        assert result >= 3_600_000
        assert result <= 3_660_000

    def test_one_shot_no_jitter_on_non_mod_minute(self) -> None:
        task = LoopTask(
            id="test0001",
            cron="7 * * * *",  # at minute 7 — not divisible by 30
            prompt="test",
            created_at=0,
            recurring=False,
        )
        cfg = JitterConfig(one_shot_max_ms=90_000, one_shot_minute_mod=30)
        result = _compute_next_fire_at(task, 0, cfg)
        assert result is not None
        # Should be exactly at minute 7 of the first hour
        assert result == 7 * 60 * 1000

    def test_one_shot_jitter_on_mod_minute(self) -> None:
        task = LoopTask(
            id="test0001",
            cron="0 * * * *",  # minute 0, divisible by 30
            prompt="test",
            created_at=0,
            recurring=False,
        )
        cfg = JitterConfig(one_shot_max_ms=90_000, one_shot_floor_ms=0, one_shot_minute_mod=30)
        result = _compute_next_fire_at(task, 0, cfg)
        assert result is not None
        # Should fire early, between 0 and 90s before the hour
        assert result <= 3_600_000
        assert result >= 3_510_000

    def test_one_shot_clamped_to_from_ms(self) -> None:
        task = LoopTask(
            id="test0001",
            cron="0 * * * *",
            prompt="test",
            created_at=0,
            recurring=False,
        )
        cfg = JitterConfig(one_shot_max_ms=90_000, one_shot_floor_ms=80_000, one_shot_minute_mod=30)
        # If from_ms is already past the early-lead window, clamp to from_ms
        from_ms = 3_595_000
        result = _compute_next_fire_at(task, from_ms, cfg)
        assert result is not None
        assert result >= from_ms


class TestLoopScheduler:
    def test_add_task(self, tmp_path: Path) -> None:
        scheduler = LoopScheduler(session_dir=tmp_path)
        task = LoopTask(
            id="task0001",
            cron="*/5 * * * *",
            prompt="check",
            created_at=0,
            recurring=True,
        )
        scheduler.add_task(task)
        assert scheduler.get_task("task0001") is not None
        assert scheduler.get_next_fire_time() is not None

    def test_add_task_exceeds_max(self, tmp_path: Path) -> None:
        config = LoopConfig(max_jobs=1)
        scheduler = LoopScheduler(session_dir=tmp_path, config=config)
        task1 = LoopTask(
            id="task0001",
            cron="*/5 * * * *",
            prompt="check",
            created_at=0,
            recurring=True,
        )
        task2 = LoopTask(
            id="task0002",
            cron="*/10 * * * *",
            prompt="check",
            created_at=0,
            recurring=True,
        )
        scheduler.add_task(task1)
        with pytest.raises(RuntimeError, match="Maximum number of scheduled tasks"):
            scheduler.add_task(task2)

    def test_remove_task(self, tmp_path: Path) -> None:
        scheduler = LoopScheduler(session_dir=tmp_path)
        task = LoopTask(
            id="task0001",
            cron="*/5 * * * *",
            prompt="check",
            created_at=0,
            recurring=True,
        )
        scheduler.add_task(task)
        scheduler.remove_task("task0001")
        assert scheduler.get_task("task0001") is None
        assert scheduler.get_next_fire_time() is None

    def test_fire_task_reschedules_recurring(self, tmp_path: Path) -> None:
        import time

        scheduler = LoopScheduler(session_dir=tmp_path)
        mock_soul = MagicMock()
        scheduler.bind_soul(mock_soul)

        now_ms = int(time.time() * 1000)
        task = LoopTask(
            id="task0001",
            cron="*/1 * * * *",  # every minute
            prompt="check",
            created_at=now_ms,
            recurring=True,
        )
        scheduler.add_task(task)
        # Force next_fire_at to be in the past
        scheduler._task_states["task0001"].next_fire_at = now_ms - 1000

        # Run tick synchronously for test
        import asyncio

        asyncio.run(scheduler._tick())

        assert mock_soul.steer.called
        assert mock_soul.steer.call_args[0][0] == "check"
        # Task should still exist and be rescheduled
        assert scheduler.get_task("task0001") is not None

    def test_fire_task_removes_one_shot(self, tmp_path: Path) -> None:
        import time

        scheduler = LoopScheduler(session_dir=tmp_path)
        mock_soul = MagicMock()
        scheduler.bind_soul(mock_soul)

        now_ms = int(time.time() * 1000)
        task = LoopTask(
            id="task0001",
            cron="*/1 * * * *",
            prompt="check",
            created_at=now_ms,
            recurring=False,
        )
        scheduler.add_task(task)
        scheduler._task_states["task0001"].next_fire_at = now_ms - 1000

        import asyncio

        asyncio.run(scheduler._tick())

        assert mock_soul.steer.called
        assert scheduler.get_task("task0001") is None

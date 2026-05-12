from __future__ import annotations

import json
from pathlib import Path

import pytest

from kimi_cli.loop.models import LoopTask
from kimi_cli.loop.store import LoopStore


@pytest.fixture
def store(tmp_path: Path) -> LoopStore:
    return LoopStore(session_dir=tmp_path)


@pytest.fixture
def sample_task() -> LoopTask:
    return LoopTask(
        id="a3f7b2d1",
        cron="*/5 * * * *",
        prompt="check deploy",
        created_at=1_000_000,
        recurring=True,
        durable=False,
    )


class TestLoopStore:
    def test_add_and_get(self, store: LoopStore, sample_task: LoopTask) -> None:
        store.add(sample_task)
        assert store.get("a3f7b2d1") == sample_task

    def test_remove(self, store: LoopStore, sample_task: LoopTask) -> None:
        store.add(sample_task)
        removed = store.remove("a3f7b2d1")
        assert removed == sample_task
        assert store.get("a3f7b2d1") is None

    def test_list_all(self, store: LoopStore, sample_task: LoopTask) -> None:
        store.add(sample_task)
        tasks = store.list_all()
        assert len(tasks) == 1
        assert tasks[0].id == "a3f7b2d1"

    def test_count(self, store: LoopStore, sample_task: LoopTask) -> None:
        assert store.count() == 0
        store.add(sample_task)
        assert store.count() == 1

    def test_update(self, store: LoopStore, sample_task: LoopTask) -> None:
        store.add(sample_task)
        updated = sample_task.model_copy(update={"prompt": "updated prompt"})
        store.update(updated)
        assert store.get("a3f7b2d1").prompt == "updated prompt"

    def test_durable_persistence(self, tmp_path: Path, sample_task: LoopTask) -> None:
        store = LoopStore(session_dir=tmp_path)
        task = sample_task.model_copy(update={"durable": True})
        store.add(task)

        durable_path = tmp_path / "scheduled.json"
        assert durable_path.exists()
        data = json.loads(durable_path.read_text())
        assert len(data["tasks"]) == 1
        assert data["tasks"][0]["id"] == "a3f7b2d1"

    def test_load_durable(self, tmp_path: Path, sample_task: LoopTask) -> None:
        store = LoopStore(session_dir=tmp_path)
        task = sample_task.model_copy(update={"durable": True})
        store.add(task)

        new_store = LoopStore(session_dir=tmp_path)
        loaded = new_store.load_durable()
        assert len(loaded) == 1
        assert loaded[0].id == "a3f7b2d1"

    def test_evict_aged(self, store: LoopStore) -> None:
        old_task = LoopTask(
            id="old00001",
            cron="*/5 * * * *",
            prompt="old task",
            created_at=0,
            recurring=True,
            durable=False,
        )
        store.add(old_task)
        evicted = store.evict_aged(max_age_ms=1000, now_ms=2000)
        assert len(evicted) == 1
        assert evicted[0].id == "old00001"
        assert store.get("old00001") is None

    def test_evict_aged_skips_permanent(self, store: LoopStore) -> None:
        permanent_task = LoopTask(
            id="perm0001",
            cron="*/5 * * * *",
            prompt="permanent",
            created_at=0,
            recurring=True,
            permanent=True,
            durable=False,
        )
        store.add(permanent_task)
        evicted = store.evict_aged(max_age_ms=1000, now_ms=2000)
        assert len(evicted) == 0
        assert store.get("perm0001") is not None

    def test_evict_aged_skips_non_recurring(self, store: LoopStore) -> None:
        one_shot = LoopTask(
            id="once0001",
            cron="*/5 * * * *",
            prompt="one shot",
            created_at=0,
            recurring=False,
            durable=False,
        )
        store.add(one_shot)
        evicted = store.evict_aged(max_age_ms=1000, now_ms=2000)
        assert len(evicted) == 0

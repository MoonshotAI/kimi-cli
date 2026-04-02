from __future__ import annotations

import json
import time

import pytest

from kimi_cli.notifications import NotificationEvent


def test_publish_dedupes_and_tracks_sink_state(runtime) -> None:
    manager = runtime.notifications
    event = NotificationEvent(
        id=manager.new_id(),
        category="task",
        type="task.completed",
        source_kind="background_task",
        source_id="b1234567",
        title="Task completed",
        body="done",
        dedupe_key="background_task:b1234567:completed",
    )

    first = manager.publish(event)
    second = manager.publish(event.model_copy(update={"id": manager.new_id()}))

    assert first.event.id == second.event.id

    claimed = manager.claim_for_sink("llm", limit=1)
    assert [view.event.id for view in claimed] == [first.event.id]
    acked = manager.ack("llm", first.event.id)
    assert acked.delivery.sinks["llm"].status == "acked"
    assert acked.delivery.sinks["wire"].status == "pending"


def test_claim_for_sink_is_fifo_and_respects_limit(runtime) -> None:
    manager = runtime.notifications
    first = manager.publish(
        NotificationEvent(
            id=manager.new_id(),
            category="system",
            type="system.info",
            source_kind="test",
            source_id="source-1",
            title="First",
            body="first",
            created_at=time.time() - 2,
        )
    )
    second = manager.publish(
        NotificationEvent(
            id=manager.new_id(),
            category="system",
            type="system.info",
            source_kind="test",
            source_id="source-2",
            title="Second",
            body="second",
            created_at=time.time() - 1,
        )
    )

    claimed_first = manager.claim_for_sink("wire", limit=1)
    claimed_second = manager.claim_for_sink("wire", limit=1)

    assert [view.event.id for view in claimed_first] == [first.event.id]
    assert [view.event.id for view in claimed_second] == [second.event.id]


def test_ack_for_one_sink_does_not_consume_other_sinks(runtime) -> None:
    manager = runtime.notifications
    event = manager.publish(
        NotificationEvent(
            id=manager.new_id(),
            category="task",
            type="task.completed",
            source_kind="background_task",
            source_id="b1234567",
            title="Task completed",
            body="done",
            targets=["llm", "wire", "shell"],
        )
    )

    manager.ack("llm", event.event.id)
    wire_claim = manager.claim_for_sink("wire", limit=1)
    shell_claim = manager.claim_for_sink("shell", limit=1)

    assert [view.event.id for view in wire_claim] == [event.event.id]
    assert [view.event.id for view in shell_claim] == [event.event.id]


def test_recover_requeues_stale_claim(runtime) -> None:
    manager = runtime.notifications
    event = NotificationEvent(
        id=manager.new_id(),
        category="system",
        type="system.info",
        source_kind="test",
        source_id="source-1",
        title="Info",
        body="hello",
    )
    created = manager.publish(event)
    delivery = created.delivery.model_copy(deep=True)
    delivery.sinks["wire"].status = "claimed"
    delivery.sinks["wire"].claimed_at = time.time() - 60
    manager.store.write_delivery(created.event.id, delivery)

    manager.recover()

    recovered = manager.store.merged_view(created.event.id)
    assert recovered.delivery.sinks["wire"].status == "pending"
    assert recovered.delivery.sinks["wire"].claimed_at is None


def test_ack_ids_missing_notification_does_not_create_directory(runtime) -> None:
    manager = runtime.notifications

    manager.ack_ids("llm", {"nmissing01"})

    assert manager.store.list_notification_ids() == []
    assert not manager.store.notification_path("nmissing01").exists()


def test_list_views_skips_incomplete_notification_directories(runtime) -> None:
    manager = runtime.notifications
    event = NotificationEvent(
        id=manager.new_id(),
        category="task",
        type="task.completed",
        source_kind="background_task",
        source_id="b1234567",
        title="Task completed",
        body="done",
    )
    manager.publish(event)

    orphan_dir = manager.store.root / "n-orphan"
    orphan_dir.mkdir(parents=True, exist_ok=True)
    (orphan_dir / manager.store.DELIVERY_FILE).write_text("{}", encoding="utf-8")

    views = manager.store.list_views()

    assert len(views) == 1
    assert views[0].event.id == event.id


def test_list_views_skips_invalid_notification_id_directories(runtime) -> None:
    manager = runtime.notifications
    event = NotificationEvent(
        id=manager.new_id(),
        category="task",
        type="task.completed",
        source_kind="background_task",
        source_id="b7654321",
        title="Task completed",
        body="done",
    )
    manager.publish(event)

    invalid_dir = manager.store.root / "n-bad!"
    invalid_dir.mkdir(parents=True, exist_ok=True)
    (invalid_dir / manager.store.EVENT_FILE).write_text("{}", encoding="utf-8")

    views = manager.store.list_views()

    assert [view.event.id for view in views] == [event.id]


@pytest.mark.asyncio
async def test_deliver_pending_runs_shared_claim_and_ack_flow(runtime) -> None:
    manager = runtime.notifications
    event = NotificationEvent(
        id=manager.new_id(),
        category="system",
        type="system.info",
        source_kind="test",
        source_id="source-1",
        title="Info",
        body="hello",
        targets=["shell"],
    )
    manager.publish(event)

    calls: list[str] = []

    async def _on_notification(view) -> None:
        calls.append(view.event.id)

    delivered = await manager.deliver_pending(
        "shell",
        before_claim=lambda: calls.append("before_claim"),
        on_notification=_on_notification,
    )

    assert calls == ["before_claim", event.id]
    assert [view.event.id for view in delivered] == [event.id]
    stored = manager.store.merged_view(event.id)
    assert stored.delivery.sinks["shell"].status == "acked"


@pytest.mark.asyncio
async def test_deliver_pending_leaves_claimed_notification_for_recovery_on_handler_error(
    runtime,
) -> None:
    manager = runtime.notifications
    event = NotificationEvent(
        id=manager.new_id(),
        category="system",
        type="system.info",
        source_kind="test",
        source_id="source-1",
        title="Info",
        body="hello",
        targets=["wire"],
    )
    manager.publish(event)

    async def _boom(_view) -> None:
        raise RuntimeError("handler failed")

    # Handler errors are caught and logged; delivery continues for remaining items.
    delivered = await manager.deliver_pending("wire", on_notification=_boom)

    assert delivered == []
    stored = manager.store.merged_view(event.id)
    assert stored.delivery.sinks["wire"].status == "claimed"


def test_list_views_skips_notification_with_corrupted_event(runtime) -> None:
    manager = runtime.notifications
    event = manager.publish(
        NotificationEvent(
            id=manager.new_id(),
            category="system",
            type="system.info",
            source_kind="test",
            source_id="source-1",
            title="Info",
            body="hello",
        )
    )
    bad_id = "ncorrupt1"
    bad_dir = manager.store.notification_dir(bad_id)
    (bad_dir / manager.store.EVENT_FILE).write_text('{"id":"ncorrupt1"', encoding="utf-8")

    views = manager.store.list_views()

    assert [view.event.id for view in views] == [event.event.id]


def test_read_delivery_invalid_json_returns_default(runtime) -> None:
    manager = runtime.notifications
    event = manager.publish(
        NotificationEvent(
            id=manager.new_id(),
            category="system",
            type="system.info",
            source_kind="test",
            source_id="source-1",
            title="Info",
            body="hello",
        )
    )
    manager.store.delivery_path(event.event.id).write_text('{"sinks":', encoding="utf-8")

    delivery = manager.store.read_delivery(event.event.id)

    assert delivery.sinks == {}


def test_recover_skips_notification_with_structurally_invalid_event(runtime) -> None:
    manager = runtime.notifications
    event = manager.publish(
        NotificationEvent(
            id=manager.new_id(),
            category="system",
            type="system.info",
            source_kind="test",
            source_id="source-1",
            title="Info",
            body="hello",
        )
    )
    bad_id = "ncorrupt2"
    bad_dir = manager.store.notification_dir(bad_id)
    (bad_dir / manager.store.EVENT_FILE).write_text(json.dumps({"oops": 1}), encoding="utf-8")

    manager.recover()

    views = manager.store.list_views()
    assert [view.event.id for view in views] == [event.event.id]

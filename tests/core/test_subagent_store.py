from __future__ import annotations

import json
import time

from kimi_cli.subagents import AgentLaunchSpec, SubagentStore


def test_create_and_load_instance(session) -> None:
    store = SubagentStore(session)
    record = store.create_instance(
        agent_id="a1234567",
        description="investigate parser bug",
        launch_spec=AgentLaunchSpec(
            agent_id="a1234567",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    loaded = store.require_instance("a1234567")
    assert loaded == record
    assert store.context_path("a1234567").exists()
    assert store.wire_path("a1234567").exists()
    assert store.prompt_path("a1234567").exists()


def test_update_and_list_instances(session) -> None:
    store = SubagentStore(session)
    first = store.create_instance(
        agent_id="a1111111",
        description="first task",
        launch_spec=AgentLaunchSpec(
            agent_id="a1111111",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )
    second = store.create_instance(
        agent_id="a2222222",
        description="second task",
        launch_spec=AgentLaunchSpec(
            agent_id="a2222222",
            subagent_type="mocker",
            model_override=None,
            effective_model=None,
        ),
    )

    updated = store.update_instance("a1111111", status="running_foreground", last_task_id="task-1")

    records = store.list_instances()
    assert records[0] == updated
    assert records[1] == second
    assert updated.created_at == first.created_at
    assert updated.last_task_id == "task-1"


def test_list_instances_on_empty_store_does_not_create_directory(session) -> None:
    store = SubagentStore(session)

    assert not store.root.exists()
    assert store.list_instances() == []
    assert not store.root.exists()


def test_update_instance_does_not_touch_auxiliary_files(session) -> None:
    store = SubagentStore(session)
    store.create_instance(
        agent_id="a3333333",
        description="task",
        launch_spec=AgentLaunchSpec(
            agent_id="a3333333",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )

    context_path = store.context_path("a3333333")
    wire_path = store.wire_path("a3333333")
    prompt_path = store.prompt_path("a3333333")
    before = {
        "context": context_path.stat().st_mtime_ns,
        "wire": wire_path.stat().st_mtime_ns,
        "prompt": prompt_path.stat().st_mtime_ns,
    }

    time.sleep(0.01)
    store.update_instance("a3333333", status="running_foreground")

    after = {
        "context": context_path.stat().st_mtime_ns,
        "wire": wire_path.stat().st_mtime_ns,
        "prompt": prompt_path.stat().st_mtime_ns,
    }

    assert after == before


def test_list_instances_skips_corrupted_meta(session) -> None:
    store = SubagentStore(session)
    store.create_instance(
        agent_id="a4444444",
        description="valid task",
        launch_spec=AgentLaunchSpec(
            agent_id="a4444444",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )
    bad_dir = store.instance_dir("a5555555", create=True)
    (bad_dir / "meta.json").write_text('{"agent_id":"a5555555","launch_spec":', encoding="utf-8")

    records = store.list_instances()

    assert [record.agent_id for record in records] == ["a4444444"]


def test_get_instance_returns_none_for_corrupted_meta(session) -> None:
    store = SubagentStore(session)
    bad_dir = store.instance_dir("a6666666", create=True)
    (bad_dir / "meta.json").write_text(json.dumps({"oops": 1}), encoding="utf-8")

    assert store.get_instance("a6666666") is None


def test_get_instance_allows_missing_last_task_id_for_legacy_meta(session) -> None:
    store = SubagentStore(session)
    legacy_dir = store.instance_dir("a6767676", create=True)
    (legacy_dir / "meta.json").write_text(
        json.dumps(
            {
                "agent_id": "a6767676",
                "subagent_type": "coder",
                "status": "idle",
                "description": "legacy task",
                "created_at": 1.0,
                "updated_at": 2.0,
                "launch_spec": {
                    "agent_id": "a6767676",
                    "subagent_type": "coder",
                    "model_override": None,
                    "effective_model": None,
                    "created_at": 1.0,
                },
            }
        ),
        encoding="utf-8",
    )

    record = store.get_instance("a6767676")

    assert record is not None
    assert record.last_task_id is None


def test_list_instances_skips_meta_with_invalid_field_types(session) -> None:
    store = SubagentStore(session)
    store.create_instance(
        agent_id="a7777777",
        description="valid task",
        launch_spec=AgentLaunchSpec(
            agent_id="a7777777",
            subagent_type="coder",
            model_override=None,
            effective_model=None,
        ),
    )
    bad_dir = store.instance_dir("a8888888", create=True)
    (bad_dir / "meta.json").write_text(
        json.dumps(
            {
                "agent_id": "a8888888",
                "subagent_type": "coder",
                "status": "idle",
                "description": "bad task",
                "created_at": "not-a-number",
                "updated_at": "also-bad",
                "last_task_id": None,
                "launch_spec": {
                    "agent_id": "a8888888",
                    "subagent_type": "coder",
                    "model_override": None,
                    "effective_model": None,
                    "created_at": "not-a-number",
                },
            }
        ),
        encoding="utf-8",
    )

    records = store.list_instances()

    assert [record.agent_id for record in records] == ["a7777777"]

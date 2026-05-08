from __future__ import annotations

import json

import pytest

from kimi_cli.background.models import TaskSpec


def _make_spec_json(**overrides) -> str:
    base = {
        "id": "test01",
        "kind": "bash",
        "session_id": "sess-1",
        "description": "test task",
        "tool_call_id": "tc-1",
    }
    base.update(overrides)
    return json.dumps(base)


def test_task_spec_owner_role_root():
    spec = TaskSpec.model_validate_json(_make_spec_json(owner_role="root"))
    assert spec.owner_role == "root"


def test_task_spec_owner_role_subagent():
    spec = TaskSpec.model_validate_json(_make_spec_json(owner_role="subagent"))
    assert spec.owner_role == "subagent"


def test_task_spec_owner_role_defaults_to_root():
    spec = TaskSpec.model_validate_json(_make_spec_json())
    assert spec.owner_role == "root"


@pytest.mark.parametrize("old_value", ["fixed_subagent", "dynamic_subagent"])
def test_task_spec_legacy_owner_role_mapped_to_subagent(old_value: str):
    """Old owner_role values from previous versions should deserialize
    as 'subagent' instead of raising ValidationError."""
    spec = TaskSpec.model_validate_json(_make_spec_json(owner_role=old_value))
    assert spec.owner_role == "subagent"

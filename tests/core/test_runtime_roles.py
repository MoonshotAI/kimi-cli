from __future__ import annotations


def test_runtime_roles_are_root_and_subagent_only(runtime):
    assert runtime.role == "root"

    subagent_runtime = runtime.copy_for_subagent(
        agent_id="atestrole",
        subagent_type="coder",
    )

    assert subagent_runtime.role == "subagent"

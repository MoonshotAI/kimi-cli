from __future__ import annotations

import platform

import pytest
from kaos.path import KaosPath


def test_runtime_roles_are_root_and_subagent_only(runtime):
    assert runtime.role == "root"

    subagent_runtime = runtime.copy_for_subagent(
        agent_id="atestrole",
        subagent_type="coder",
    )

    assert subagent_runtime.role == "subagent"


@pytest.mark.skipif(platform.system() == "Windows", reason="Skipping test on Windows")
async def test_copy_for_subagent_with_work_dir_override(runtime, temp_work_dir):
    from kimi_cli.agentspec import DEFAULT_AGENT_FILE
    from kimi_cli.soul.agent import load_agent

    await load_agent(DEFAULT_AGENT_FILE, runtime, mcp_configs=[])

    override_dir = KaosPath("/tmp/worktree-override")
    sub = runtime.copy_for_subagent(
        agent_id="awdtest",
        subagent_type="coder",
        work_dir_override=override_dir,
    )
    assert override_dir == sub.builtin_args.KIMI_WORK_DIR
    # Original runtime unchanged
    assert temp_work_dir == runtime.builtin_args.KIMI_WORK_DIR


def test_copy_for_subagent_without_work_dir_override_inherits_original(runtime):
    sub = runtime.copy_for_subagent(
        agent_id="anowd",
        subagent_type="coder",
    )
    assert sub.builtin_args.KIMI_WORK_DIR == runtime.builtin_args.KIMI_WORK_DIR

from __future__ import annotations

from kimi_cli.soul.agent import Runtime


def test_runtime_copy_propagates_agents_md(runtime: Runtime):
    fixed = runtime.copy_for_fixed_subagent()
    dynamic = runtime.copy_for_dynamic_subagent()

    assert fixed.agents_md == runtime.agents_md
    assert dynamic.agents_md == runtime.agents_md

    assert fixed is not runtime
    assert dynamic is not runtime
    assert fixed.labor_market is not runtime.labor_market
    assert dynamic.labor_market is runtime.labor_market
    assert fixed.denwa_renji is not runtime.denwa_renji
    assert dynamic.denwa_renji is not runtime.denwa_renji

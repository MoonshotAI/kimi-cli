import pytest

from kimi_cli.hooks.config import HookDef
from kimi_cli.hooks.engine import HookEngine


@pytest.fixture
def engine():
    hooks = [
        HookDef(event="PreToolUse", matcher="Shell|WriteFile", command="exit 0", timeout=5),
        HookDef(event="PreToolUse", matcher="ReadFile", command="exit 2", timeout=5),
        HookDef(event="Stop", matcher="", command="echo done", timeout=5),
    ]
    return HookEngine(hooks)


@pytest.mark.asyncio
async def test_match_tool_name(engine):
    results = await engine.trigger(
        "PreToolUse", matcher_value="Shell", input_data={"tool_name": "Shell"}
    )
    assert len(results) == 1
    assert results[0].action == "allow"


@pytest.mark.asyncio
async def test_no_match(engine):
    results = await engine.trigger("PreToolUse", matcher_value="Grep", input_data={})
    assert len(results) == 0


@pytest.mark.asyncio
async def test_block(engine):
    results = await engine.trigger("PreToolUse", matcher_value="ReadFile", input_data={})
    assert len(results) == 1
    assert results[0].action == "block"


@pytest.mark.asyncio
async def test_empty_matcher_matches_all(engine):
    results = await engine.trigger("Stop", matcher_value="anything", input_data={})
    assert len(results) == 1


@pytest.mark.asyncio
async def test_no_hooks_for_event(engine):
    results = await engine.trigger("UserPromptSubmit", matcher_value="", input_data={})
    assert len(results) == 0


@pytest.mark.asyncio
async def test_dedup_identical_commands():
    hooks = [
        HookDef(event="Stop", command="echo once", timeout=5),
        HookDef(event="Stop", command="echo once", timeout=5),
    ]
    engine = HookEngine(hooks)
    results = await engine.trigger("Stop", input_data={})
    assert len(results) == 1


@pytest.mark.asyncio
async def test_invalid_regex_skips_hook():
    hooks = [
        HookDef(event="PreToolUse", matcher="[invalid", command="exit 0", timeout=5),
    ]
    engine = HookEngine(hooks)
    # Should not raise, just skip the hook with invalid regex
    results = await engine.trigger("PreToolUse", matcher_value="Shell", input_data={})
    assert len(results) == 0

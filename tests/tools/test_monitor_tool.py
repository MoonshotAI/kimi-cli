import pytest

from kimi_cli.soul.toolset import current_tool_call
from kimi_cli.tools.monitor import Monitor, MonitorParams
from kimi_cli.wire.types import ToolCall


def _tool_call_token():
    return current_tool_call.set(
        ToolCall(id="test", function=ToolCall.FunctionBody(name="Monitor", arguments=None))
    )


@pytest.fixture
def monitor_tool(approval, environment, runtime):
    token = _tool_call_token()
    try:
        yield Monitor(approval, environment, runtime)
    finally:
        current_tool_call.reset(token)


@pytest.fixture
def subagent_monitor_tool(approval, environment, runtime):
    original_role = runtime.role
    runtime.role = "subagent"
    token = _tool_call_token()
    try:
        yield Monitor(approval, environment, runtime)
    finally:
        current_tool_call.reset(token)
        runtime.role = original_role


def test_params_bounds_and_defaults():
    from pydantic import ValidationError

    p = MonitorParams(command="tail -f x | grep --line-buffered ERR", description="errs")
    assert p.timeout_ms == 300000 and p.persistent is False
    with pytest.raises(ValidationError):
        MonitorParams(command="x", description="d", timeout_ms=10)  # below min 1000


@pytest.mark.asyncio
async def test_non_root_is_rejected(subagent_monitor_tool):
    res = await subagent_monitor_tool(MonitorParams(command="true", description="d"))
    assert res.is_error

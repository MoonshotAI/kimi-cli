import pytest

from kimi_cli.hooks.runner import run_hook


@pytest.mark.asyncio
async def test_exit_0_allows():
    result = await run_hook("echo ok", {"tool_name": "Shell"}, timeout=5)
    assert result.action == "allow"
    assert result.stdout.strip() == "ok"


@pytest.mark.asyncio
async def test_exit_2_blocks():
    result = await run_hook("echo 'blocked' >&2; exit 2", {"tool_name": "Shell"}, timeout=5)
    assert result.action == "block"
    assert "blocked" in result.reason


@pytest.mark.asyncio
async def test_exit_1_allows():
    result = await run_hook("exit 1", {"tool_name": "Shell"}, timeout=5)
    assert result.action == "allow"


@pytest.mark.asyncio
async def test_timeout_allows():
    result = await run_hook("sleep 10", {"tool_name": "Shell"}, timeout=1)
    assert result.action == "allow"
    assert result.timed_out


@pytest.mark.asyncio
async def test_json_deny_decision():
    cmd = """echo '{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "use rg"}}' """
    result = await run_hook(cmd, {"tool_name": "Bash"}, timeout=5)
    assert result.action == "block"
    assert result.reason == "use rg"


@pytest.mark.asyncio
async def test_stdin_receives_json():
    cmd = """python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tool_name'])" """
    result = await run_hook(cmd, {"tool_name": "WriteFile"}, timeout=5)
    assert result.stdout.strip() == "WriteFile"


@pytest.mark.asyncio
async def test_additional_context_default_empty():
    result = await run_hook("echo ok", {"tool_name": "Shell"}, timeout=5)
    assert result.additional_context == ""


@pytest.mark.asyncio
async def test_additional_context_from_json():
    cmd = """echo '{"hookSpecificOutput": {"additionalContext": "skill content"}}' """
    result = await run_hook(cmd, {"tool_name": "Shell"}, timeout=5)
    assert result.action == "allow"
    assert result.additional_context == "skill content"


@pytest.mark.asyncio
async def test_deny_clears_additional_context():
    cmd = """echo '{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "blocked", "additionalContext": "should be ignored"}}' """
    result = await run_hook(cmd, {"tool_name": "Shell"}, timeout=5)
    assert result.action == "block"
    assert result.additional_context == ""


@pytest.mark.asyncio
async def test_additional_context_with_deny():
    cmd = """echo '{"hookSpecificOutput": {"additionalContext": "skill content", "permissionDecision": "deny"}}' """
    result = await run_hook(cmd, {"tool_name": "Shell"}, timeout=5)
    assert result.action == "block"
    assert result.additional_context == ""

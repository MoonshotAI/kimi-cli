import tempfile
from pathlib import Path

import pytest
import tomlkit

from kimi_cli.hooks.config import HookDef
from kimi_cli.hooks.engine import HookEngine


@pytest.mark.asyncio
async def test_pre_tool_use_block_flow():
    """Full flow: hook blocks a dangerous command."""
    with tempfile.TemporaryDirectory() as tmpdir:
        script = Path(tmpdir) / "block-rm.sh"
        script.write_text(
            '#!/bin/bash\n'
            'CMD=$(python3 -c "import sys,json; print(json.load(sys.stdin).get(\'tool_input\',{}).get(\'command\',\'\'))")\n'
            'if echo "$CMD" | grep -q "rm -rf"; then echo "Blocked: rm -rf" >&2; exit 2; fi\n'
            'exit 0\n'
        )
        script.chmod(0o755)

        hooks = [HookDef(event="PreToolUse", matcher="Shell", command=str(script), timeout=5)]
        engine = HookEngine(hooks, cwd=tmpdir)

        # Safe command -> allow
        results = await engine.trigger(
            "PreToolUse",
            matcher_value="Shell",
            input_data={"tool_name": "Shell", "tool_input": {"command": "ls -la"}},
        )
        assert all(r.action == "allow" for r in results)

        # Dangerous command -> block
        results = await engine.trigger(
            "PreToolUse",
            matcher_value="Shell",
            input_data={"tool_name": "Shell", "tool_input": {"command": "rm -rf /"}},
        )
        assert any(r.action == "block" for r in results)
        assert "rm -rf" in results[0].reason


@pytest.mark.asyncio
async def test_stop_hook_feedback():
    """Stop hook returns block with reason."""
    hooks = [
        HookDef(
            event="Stop",
            command="""echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"tests not written"}}' """,
            timeout=5,
        )
    ]
    engine = HookEngine(hooks)

    results = await engine.trigger("Stop", input_data={"stop_hook_active": False})
    assert len(results) == 1
    assert results[0].action == "block"
    assert "tests not written" in results[0].reason


@pytest.mark.asyncio
async def test_notification_hook():
    """Notification hook fires for matching type."""
    hooks = [
        HookDef(event="Notification", matcher="task_completed", command="echo notified", timeout=5),
        HookDef(event="Notification", matcher="other_type", command="echo other", timeout=5),
    ]
    engine = HookEngine(hooks)

    results = await engine.trigger(
        "Notification",
        matcher_value="task_completed",
        input_data={"notification_type": "task_completed", "title": "Done"},
    )
    assert len(results) == 1
    assert results[0].stdout.strip() == "notified"


@pytest.mark.asyncio
async def test_multiple_hooks_same_event():
    """Multiple hooks for same event run in parallel."""
    hooks = [
        HookDef(event="PostToolUse", matcher="WriteFile", command="echo hook1", timeout=5),
        HookDef(event="PostToolUse", matcher="WriteFile", command="echo hook2", timeout=5),
    ]
    engine = HookEngine(hooks)

    results = await engine.trigger(
        "PostToolUse",
        matcher_value="WriteFile",
        input_data={"tool_name": "WriteFile"},
    )
    assert len(results) == 2
    outputs = {r.stdout.strip() for r in results}
    assert outputs == {"hook1", "hook2"}


def test_config_roundtrip_toml():
    """Hooks survive TOML serialize/deserialize."""
    toml_str = '''
default_model = ""

[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "echo ok"

[[hooks]]
event = "Notification"
matcher = "permission_prompt"
command = "notify-send Kimi"
timeout = 5
'''
    from kimi_cli.config import Config

    data = tomlkit.parse(toml_str)
    config = Config.model_validate(data)
    assert len(config.hooks) == 2
    assert config.hooks[0].event == "PreToolUse"
    assert config.hooks[1].event == "Notification"
    assert config.hooks[1].timeout == 5


def test_hook_engine_summary():
    """Engine summary returns event -> count mapping."""
    hooks = [
        HookDef(event="PreToolUse", matcher="Shell", command="echo 1"),
        HookDef(event="PreToolUse", matcher="WriteFile", command="echo 2"),
        HookDef(event="Stop", command="echo 3"),
    ]
    engine = HookEngine(hooks)
    summary = engine.summary
    assert summary == {"PreToolUse": 2, "Stop": 1}


@pytest.mark.asyncio
async def test_session_hooks_payload():
    """SessionStart/End hooks receive correct payloads."""
    from kimi_cli.hooks import events

    hooks = [
        HookDef(
            event="SessionStart",
            matcher="startup",
            command="""python3 -c "import sys,json; d=json.load(sys.stdin); print(d['source'])" """,
            timeout=5,
        )
    ]
    engine = HookEngine(hooks)

    results = await engine.trigger(
        "SessionStart",
        matcher_value="startup",
        input_data=events.session_start(session_id="test-123", cwd="/tmp", source="startup"),
    )
    assert len(results) == 1
    assert results[0].stdout.strip() == "startup"

    # Resume should not match "startup" matcher
    results = await engine.trigger(
        "SessionStart",
        matcher_value="resume",
        input_data=events.session_start(session_id="test-123", cwd="/tmp", source="resume"),
    )
    assert len(results) == 0


@pytest.mark.asyncio
async def test_post_tool_use_failure_hook():
    """PostToolUseFailure hook fires for matching tool."""
    hooks = [HookDef(event="PostToolUseFailure", matcher="Shell", command="echo failure_caught", timeout=5)]
    engine = HookEngine(hooks)
    results = await engine.trigger(
        "PostToolUseFailure",
        matcher_value="Shell",
        input_data={"tool_name": "Shell", "tool_input": {}, "error": "command not found"},
    )
    assert len(results) == 1
    assert results[0].action == "allow"
    assert "failure_caught" in results[0].stdout


@pytest.mark.asyncio
async def test_user_prompt_submit_block():
    """UserPromptSubmit hook can block a prompt."""
    hooks = [HookDef(event="UserPromptSubmit", command="echo 'no profanity' >&2; exit 2", timeout=5)]
    engine = HookEngine(hooks)
    results = await engine.trigger(
        "UserPromptSubmit",
        input_data={"prompt": "bad words here"},
    )
    assert len(results) == 1
    assert results[0].action == "block"
    assert "no profanity" in results[0].reason


@pytest.mark.asyncio
async def test_stop_failure_hook():
    """StopFailure hook fires on error."""
    hooks = [HookDef(event="StopFailure", command="echo error_logged", timeout=5)]
    engine = HookEngine(hooks)
    results = await engine.trigger(
        "StopFailure",
        input_data={"error_type": "ChatProviderError", "error_message": "rate limited"},
    )
    assert len(results) == 1
    assert "error_logged" in results[0].stdout


@pytest.mark.asyncio
async def test_session_end_hook():
    """SessionEnd hook fires only for matching reason."""
    hooks = [HookDef(event="SessionEnd", matcher="exit", command="echo goodbye", timeout=5)]
    engine = HookEngine(hooks)

    # Matching reason
    results = await engine.trigger(
        "SessionEnd",
        matcher_value="exit",
        input_data={"session_id": "s1", "reason": "exit"},
    )
    assert len(results) == 1

    # Non-matching reason
    results = await engine.trigger(
        "SessionEnd",
        matcher_value="clear",
        input_data={"session_id": "s1", "reason": "clear"},
    )
    assert len(results) == 0


@pytest.mark.asyncio
async def test_subagent_start_hook():
    """SubagentStart hook fires for matching agent name."""
    hooks = [HookDef(event="SubagentStart", matcher="coder", command="echo agent_starting", timeout=5)]
    engine = HookEngine(hooks)
    results = await engine.trigger(
        "SubagentStart",
        matcher_value="coder",
        input_data={"agent_name": "coder", "prompt": "Fix the bug"},
    )
    assert len(results) == 1
    assert "agent_starting" in results[0].stdout


@pytest.mark.asyncio
async def test_subagent_stop_hook():
    """SubagentStop hook fires for matching agent name."""
    hooks = [HookDef(event="SubagentStop", matcher="coder", command="echo agent_done", timeout=5)]
    engine = HookEngine(hooks)
    results = await engine.trigger(
        "SubagentStop",
        matcher_value="coder",
        input_data={"agent_name": "coder", "response": "Bug fixed"},
    )
    assert len(results) == 1
    assert "agent_done" in results[0].stdout


@pytest.mark.asyncio
async def test_compact_hooks():
    """PreCompact and PostCompact hooks fire for matching trigger."""
    hooks = [
        HookDef(event="PreCompact", matcher="auto", command="echo pre_compact", timeout=5),
        HookDef(event="PostCompact", matcher="auto", command="echo post_compact", timeout=5),
    ]
    engine = HookEngine(hooks)

    pre = await engine.trigger(
        "PreCompact",
        matcher_value="auto",
        input_data={"trigger": "auto", "token_count": 150000},
    )
    assert len(pre) == 1
    assert "pre_compact" in pre[0].stdout

    post = await engine.trigger(
        "PostCompact",
        matcher_value="auto",
        input_data={"trigger": "auto", "estimated_token_count": 50000},
    )
    assert len(post) == 1
    assert "post_compact" in post[0].stdout


@pytest.mark.asyncio
async def test_wire_callbacks_fired():
    """Wire callbacks on_triggered and on_resolved are called."""
    triggered = []
    resolved = []

    hooks = [HookDef(event="PreToolUse", matcher="Shell", command="exit 0", timeout=5)]
    engine = HookEngine(
        hooks,
        on_triggered=lambda e, t, c: triggered.append((e, t, c)),
        on_resolved=lambda e, t, a, r, d: resolved.append((e, t, a)),
    )

    await engine.trigger("PreToolUse", matcher_value="Shell", input_data={})

    assert len(triggered) == 1
    assert triggered[0] == ("PreToolUse", "Shell", 1)
    assert len(resolved) == 1
    assert resolved[0] == ("PreToolUse", "Shell", "allow")

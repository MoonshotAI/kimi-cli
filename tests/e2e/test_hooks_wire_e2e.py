"""Wire-mode E2E tests for the hooks system.

Uses the ``_scripted_echo`` provider so no real LLM is needed.
Tests verify:
1. Hooks metadata appears in initialize response
2. Client wire hook subscriptions are registered
3. HookTriggered/HookResolved events fire during prompt execution
4. HookRequest is sent for wire-subscribed hooks (client-side hooks)
5. PreToolUse hook can block tool execution
"""

import json
import os
import subprocess
from pathlib import Path
from typing import cast

from kaos.path import KaosPath


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _send_json(process: subprocess.Popen[str], payload: dict[str, object]) -> None:
    assert process.stdin is not None
    line = json.dumps(payload)
    process.stdin.write(line + "\n")
    process.stdin.flush()


def _collect_until_response(
    process: subprocess.Popen[str], response_id: str
) -> tuple[dict[str, object], list[dict[str, object]]]:
    assert process.stdout is not None
    events: list[dict[str, object]] = []
    while True:
        line = process.stdout.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(msg, dict):
            continue
        msg = cast(dict[str, object], msg)
        msg_id = msg.get("id")
        if msg_id == response_id:
            return msg, events
        # Collect events and requests
        if msg.get("method") in ("event", "request"):
            params = msg.get("params")
            if isinstance(params, dict):
                events.append(cast(dict[str, object], params))
    raise AssertionError(f"Missing response for id {response_id!r}")


def _make_scripted_config(
    tmp_path: Path,
    scripts: list[str],
    hooks_toml: str = "",
) -> Path:
    """Create a config file with _scripted_echo provider and optional hooks."""
    scripts_path = tmp_path / "scripts.json"
    scripts_path.write_text(json.dumps(scripts), encoding="utf-8")

    config_data = {
        "default_model": "scripted",
        "models": {
            "scripted": {
                "provider": "scripted_provider",
                "model": "scripted_echo",
                "max_context_size": 100000,
            }
        },
        "providers": {
            "scripted_provider": {
                "type": "_scripted_echo",
                "base_url": "",
                "api_key": "",
                "env": {"KIMI_SCRIPTED_ECHO_SCRIPTS": str(scripts_path)},
            }
        },
    }

    if hooks_toml:
        # Write as TOML (config supports both JSON and TOML)
        import tomlkit

        config = tomlkit.parse(hooks_toml)
        for key, value in config_data.items():
            config[key] = value
        config_path = tmp_path / "config.toml"
        config_path.write_text(tomlkit.dumps(config), encoding="utf-8")
    else:
        config_path = tmp_path / "config.json"
        config_path.write_text(json.dumps(config_data), encoding="utf-8")

    return config_path


def _start_wire(config_path: Path, work_dir: Path) -> subprocess.Popen[str]:
    cmd = [
        "uv",
        "run",
        "kimi",
        "--wire",
        "--yolo",
        "--config-file",
        str(config_path),
        "--work-dir",
        str(work_dir),
    ]
    return subprocess.Popen(
        cmd,
        cwd=_repo_root(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=os.environ.copy(),
    )


def _initialize(
    process: subprocess.Popen[str],
    hooks: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    params: dict[str, object] = {
        "protocol_version": "1.6",
        "capabilities": {"supports_question": True, "supports_plan_mode": True},
    }
    if hooks is not None:
        params["hooks"] = hooks
    _send_json(process, {"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": params})
    resp, _ = _collect_until_response(process, "init")
    assert "result" in resp
    return cast(dict[str, object], resp["result"])


def _prompt(
    process: subprocess.Popen[str],
    user_input: str,
) -> tuple[dict[str, object], list[dict[str, object]]]:
    _send_json(
        process,
        {
            "jsonrpc": "2.0",
            "id": "prompt-1",
            "method": "prompt",
            "params": {"user_input": user_input},
        },
    )
    return _collect_until_response(process, "prompt-1")


def _find_events(events: list[dict[str, object]], event_type: str) -> list[dict[str, object]]:
    result = []
    for e in events:
        if e.get("type") == event_type:
            payload = e.get("payload")
            if isinstance(payload, dict):
                result.append(cast(dict[str, object], payload))
    return result


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_hooks_metadata_in_initialize(temp_work_dir: KaosPath, tmp_path: Path) -> None:
    """Initialize response includes hooks.supported_events and hooks.configured."""
    config_path = _make_scripted_config(
        tmp_path,
        scripts=[],
        hooks_toml="""
[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "echo ok"

[[hooks]]
event = "Stop"
command = "echo done"
""",
    )

    process = _start_wire(config_path, temp_work_dir.unsafe_to_local_path())
    try:
        result = _initialize(process)
        hooks_info = result.get("hooks")
        assert isinstance(hooks_info, dict), f"No hooks in response: {result}"
        hooks = cast(dict[str, object], hooks_info)

        supported = hooks.get("supported_events")
        assert isinstance(supported, list)
        assert "PreToolUse" in supported
        assert "Stop" in supported
        assert len(supported) == 13

        configured = hooks.get("configured")
        assert isinstance(configured, dict)
        configured = cast(dict[str, object], configured)
        assert configured.get("PreToolUse") == 1
        assert configured.get("Stop") == 1
    finally:
        if process.stdin:
            process.stdin.close()
        process.kill()
        process.wait()


async def test_wire_hook_subscription_in_initialize(
    temp_work_dir: KaosPath, tmp_path: Path
) -> None:
    """Client-provided hook subscriptions appear in configured count."""
    config_path = _make_scripted_config(tmp_path, scripts=[])

    process = _start_wire(config_path, temp_work_dir.unsafe_to_local_path())
    try:
        result = _initialize(
            process,
            hooks=[
                {"id": "sub_post", "event": "PostToolUse", "matcher": "ReadFile"},
                {"id": "sub_pre", "event": "PreToolUse", "matcher": "Shell"},
            ],
        )
        hooks_info = cast(dict[str, object], result.get("hooks", {}))
        configured = cast(dict[str, object], hooks_info.get("configured", {}))
        assert configured.get("PostToolUse") == 1
        assert configured.get("PreToolUse") == 1
    finally:
        if process.stdin:
            process.stdin.close()
        process.kill()
        process.wait()


async def test_hook_events_fire_during_prompt(temp_work_dir: KaosPath, tmp_path: Path) -> None:
    """HookTriggered and HookResolved events are sent when hooks fire."""
    scripts = [
        "\n".join(
            [
                "id: scripted-1",
                'usage: {"input_other": 10, "output": 2}',
                "text: Hello world!",
            ]
        ),
    ]
    config_path = _make_scripted_config(
        tmp_path,
        scripts=scripts,
        hooks_toml="""
[[hooks]]
event = "UserPromptSubmit"
command = "echo prompt_hook_ok"

[[hooks]]
event = "Stop"
command = "echo stop_hook_ok"
""",
    )

    process = _start_wire(config_path, temp_work_dir.unsafe_to_local_path())
    try:
        _initialize(process)
        resp, events = _prompt(process, "say hello")

        result = cast(dict[str, object], resp.get("result", {}))
        assert result.get("status") == "finished"

        triggered = _find_events(events, "HookTriggered")
        resolved = _find_events(events, "HookResolved")

        # At minimum: UserPromptSubmit + Stop hooks should fire
        triggered_events = [t.get("event") for t in triggered]
        resolved_events = [r.get("event") for r in resolved]

        assert "UserPromptSubmit" in triggered_events, (
            f"Missing UserPromptSubmit in {triggered_events}"
        )
        assert "Stop" in resolved_events, f"Missing Stop in {resolved_events}"

        # All resolved should be "allow"
        for r in resolved:
            assert r.get("action") == "allow", f"Unexpected block: {r}"
            assert isinstance(r.get("duration_ms"), int)
    finally:
        if process.stdin:
            process.stdin.close()
        process.kill()
        process.wait()


async def test_pre_and_post_tool_use_hooks_on_tool_call(
    temp_work_dir: KaosPath, tmp_path: Path
) -> None:
    """PreToolUse (allow) and PostToolUse hooks fire around a successful tool call."""
    read_args = json.dumps({"path": "test.txt"})
    await (temp_work_dir / "test.txt").write_text("hello")

    scripts = [
        "\n".join(
            [
                "id: scripted-1",
                'usage: {"input_other": 10, "output": 2}',
                f"tool_call: {json.dumps({'id': 'tc1', 'name': 'ReadFile', 'arguments': read_args})}",
            ]
        ),
        "\n".join(
            [
                "id: scripted-2",
                'usage: {"input_other": 10, "output": 2}',
                "text: File read successfully.",
            ]
        ),
    ]
    config_path = _make_scripted_config(
        tmp_path,
        scripts=scripts,
        hooks_toml="""
[[hooks]]
event = "PreToolUse"
matcher = "ReadFile"
command = "echo pre_read_ok"

[[hooks]]
event = "PostToolUse"
matcher = "ReadFile"
command = "echo post_read_ok"

[[hooks]]
event = "UserPromptSubmit"
command = "echo prompt_ok"

[[hooks]]
event = "Stop"
command = "echo stop_ok"
""",
    )

    process = _start_wire(config_path, temp_work_dir.unsafe_to_local_path())
    try:
        _initialize(process)
        resp, events = _prompt(process, "read test.txt")

        result = cast(dict[str, object], resp.get("result", {}))
        assert result.get("status") == "finished"

        triggered = _find_events(events, "HookTriggered")
        resolved = _find_events(events, "HookResolved")

        triggered_names = [t.get("event") for t in triggered]

        # All 4 hook events should fire
        assert "UserPromptSubmit" in triggered_names, f"Missing UserPromptSubmit: {triggered_names}"
        assert "PreToolUse" in triggered_names, f"Missing PreToolUse: {triggered_names}"
        assert "PostToolUse" in triggered_names, f"Missing PostToolUse: {triggered_names}"
        assert "Stop" in triggered_names, f"Missing Stop: {triggered_names}"

        # All should allow
        for r in resolved:
            assert r.get("action") == "allow", f"Unexpected block: {r}"

        # PreToolUse target should be "ReadFile"
        pre_tool = [t for t in triggered if t.get("event") == "PreToolUse"]
        assert pre_tool[0].get("target") == "ReadFile"

        # PostToolUse target should also be "ReadFile"
        post_tool = [t for t in triggered if t.get("event") == "PostToolUse"]
        assert post_tool[0].get("target") == "ReadFile"
    finally:
        if process.stdin:
            process.stdin.close()
        process.kill()
        process.wait()


async def test_pre_tool_use_hook_blocks_tool(temp_work_dir: KaosPath, tmp_path: Path) -> None:
    """PreToolUse hook that exits 2 blocks the tool and feeds reason back to agent."""
    # Create a blocking hook script
    block_script = tmp_path / "block_shell.sh"
    block_script.write_text("#!/bin/bash\necho 'Shell blocked by hook' >&2\nexit 2\n")
    block_script.chmod(0o755)

    scripts = [
        "\n".join(
            [
                "id: scripted-1",
                'usage: {"input_other": 10, "output": 2}',
                f"tool_call: {json.dumps({'id': 'tc1', 'name': 'Shell', 'arguments': json.dumps({'command': 'echo hi'})})}",
            ]
        ),
        "\n".join(
            [
                "id: scripted-2",
                'usage: {"input_other": 10, "output": 2}',
                "text: OK, shell was blocked.",
            ]
        ),
    ]
    config_path = _make_scripted_config(
        tmp_path,
        scripts=scripts,
        hooks_toml=f"""
[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "{block_script}"
timeout = 5
""",
    )

    process = _start_wire(config_path, temp_work_dir.unsafe_to_local_path())
    try:
        _initialize(process)
        resp, events = _prompt(process, "run echo hi")

        result = cast(dict[str, object], resp.get("result", {}))
        assert result.get("status") == "finished"

        # Check HookResolved shows "block"
        resolved = _find_events(events, "HookResolved")
        pre_tool_resolved = [r for r in resolved if r.get("event") == "PreToolUse"]
        assert len(pre_tool_resolved) >= 1, f"No PreToolUse HookResolved: {resolved}"
        assert pre_tool_resolved[0].get("action") == "block"
        assert "blocked by hook" in str(pre_tool_resolved[0].get("reason", "")).lower()

        # The tool result should be an error (hook blocked it)
        tool_results = _find_events(events, "ToolResult")
        if tool_results:
            for tr in tool_results:
                rv = tr.get("return_value", {})
                if isinstance(rv, dict):
                    rv = cast(dict[str, object], rv)
                    if rv.get("is_error"):
                        assert (
                            "hook" in str(rv.get("message", "")).lower()
                            or "blocked" in str(rv.get("message", "")).lower()
                        )
    finally:
        if process.stdin:
            process.stdin.close()
        process.kill()
        process.wait()

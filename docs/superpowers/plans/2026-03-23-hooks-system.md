# Hooks System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hooks system to kimi-cli that runs user-defined shell commands at key agent lifecycle points, aligning with Claude Code's hooks architecture. All 13 hook events are implemented in one phase.

**Architecture:** Hooks are defined in `config.toml` using `[[hooks]]` flat array syntax. A `HookEngine` loads hooks at startup, matches events via regex, and executes matched hooks in parallel. The wire protocol exposes hooks metadata in the `initialize` response (protocol version bumped to 1.6). Hook commands receive JSON context on stdin and control flow via exit codes (0=allow, 2=block).

**Tech Stack:** Python 3.12+, asyncio, Pydantic, subprocess, TOML (tomlkit)

---

## Supported Hook Events

All events, their trigger points in kimi-cli, and what the matcher filters:

| Event | Trigger Point | File:Line | Matcher Filters | Available Context |
|-------|--------------|-----------|-----------------|-------------------|
| `PreToolUse` | Before `tool.call()` | `toolset.py:132` | tool name | tool_name, tool_input, tool_call_id |
| `PostToolUse` | After successful `tool.call()` | `toolset.py:133` | tool name | tool_name, tool_input, tool_output |
| `PostToolUseFailure` | After `tool.call()` raises | `toolset.py:135` | tool name | tool_name, tool_input, error |
| `UserPromptSubmit` | Before processing user input | `kimisoul.py:425` | (none, always fires) | prompt |
| `Stop` | Agent turn ends | `kimisoul.py:447` | (none, always fires) | stop_hook_active |
| `StopFailure` | Turn ends due to error | `kimisoul.py:612` + `server.py:497` | error type | error_type, error_message |
| `SessionStart` | Session created/resumed | `cli/__init__.py:493-504` | source (`startup`, `resume`) | session_id, work_dir |
| `SessionEnd` | Session closes | `cli/__init__.py:549-570` (finally block) | reason | session_id |
| `SubagentStart` | Subagent spawns | `task.py:136` | agent name | agent_name, prompt |
| `SubagentStop` | Subagent finishes | `task.py:144` | agent name | agent_name, response |
| `PreCompact` | Before context compaction | `kimisoul.py:820` | trigger (`manual`, `auto`) | token_count |
| `PostCompact` | After context compaction | `kimisoul.py:847` | trigger (`manual`, `auto`) | estimated_token_count |
| `Notification` | Notification delivered to sink | `notifications/manager.py:91` (`deliver_pending`) | sink name (`llm`, `wire`, `shell`) | notification_type, title, body, severity |

## Configuration Format

Hooks live in `config.toml` alongside existing config, using a flat `[[hooks]]` array:

```toml
# Auto-format after file edits
[[hooks]]
event = "PostToolUse"
matcher = "WriteFile|StrReplaceFile"
command = "jq -r '.tool_input.file_path' | xargs prettier --write"

# Block edits to .env files
[[hooks]]
event = "PreToolUse"
matcher = "WriteFile|StrReplaceFile"
command = ".kimi/hooks/protect-files.sh"
timeout = 10

# Desktop notification when waiting for approval
[[hooks]]
event = "Notification"
matcher = "permission_prompt"
command = "osascript -e 'display notification \"Kimi needs attention\" with title \"Kimi CLI\"'"

# Verify tasks complete before stopping
[[hooks]]
event = "Stop"
command = ".kimi/hooks/check-complete.sh"
```

**Fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `event` | Yes | — | One of the 13 event types above |
| `command` | Yes | — | Shell command. Receives JSON on stdin |
| `matcher` | No | `""` | Regex pattern to filter. Empty = match all |
| `timeout` | No | `30` | Seconds before timeout (fail-open) |

## Communication Protocol

**Input (stdin):** JSON with event-specific fields + common fields:

```json
{
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "hook_event_name": "PreToolUse",
  "tool_name": "Shell",
  "tool_input": {"command": "rm -rf /"}
}
```

**Output (exit code):**

| Exit Code | Behavior | Feedback |
|-----------|----------|----------|
| 0 | Allow | stdout added to context (if non-empty) |
| 2 | Block | stderr fed back to LLM as correction |
| Other | Allow | stderr logged only (not shown to LLM) |

**Structured JSON output** (exit 0 + JSON on stdout):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Use rg instead of grep"
  }
}
```

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/kimi_cli/hooks/__init__.py` | Create | Public API exports |
| `src/kimi_cli/hooks/config.py` | Create | Pydantic models: `HookDef`, `HookEventType` |
| `src/kimi_cli/hooks/engine.py` | Create | Core: load from config, match events, execute in parallel |
| `src/kimi_cli/hooks/runner.py` | Create | Single hook: spawn subprocess, pipe stdin, parse exit code |
| `src/kimi_cli/hooks/events.py` | Create | Input payload builders per event type |
| `src/kimi_cli/config.py` | Modify | Add `hooks: list[HookDef]` to `Config` model |
| `src/kimi_cli/soul/toolset.py` | Modify | Inject PreToolUse/PostToolUse/PostToolUseFailure |
| `src/kimi_cli/soul/kimisoul.py` | Modify | Inject UserPromptSubmit, Stop, StopFailure, PreCompact, PostCompact, Notification |
| `src/kimi_cli/tools/multiagent/task.py` | Modify | Inject SubagentStart/SubagentStop |
| `src/kimi_cli/app.py` | Modify | Create HookEngine at startup, inject SessionStart |
| `src/kimi_cli/wire/server.py` | Modify | Inject SessionEnd, expose hooks in initialize response |
| `src/kimi_cli/wire/protocol.py` | Modify | Bump `WIRE_PROTOCOL_VERSION` to `"1.6"` |
| `tests/hooks/test_config.py` | Create | Config parsing tests |
| `tests/hooks/test_runner.py` | Create | Subprocess execution tests |
| `tests/hooks/test_engine.py` | Create | Matching + parallel execution tests |
| `tests/hooks/test_integration.py` | Create | End-to-end tool blocking tests |

---

### Task 1: Hook Configuration Models + Config Integration

**Files:**
- Create: `src/kimi_cli/hooks/__init__.py`
- Create: `src/kimi_cli/hooks/config.py`
- Modify: `src/kimi_cli/config.py:172-205` (add `hooks` field to `Config`)
- Test: `tests/hooks/test_config.py`

- [ ] **Step 1: Write config test**

```python
# tests/hooks/test_config.py
import pytest
import tomlkit
from kimi_cli.hooks.config import HookDef, HookEventType, HOOK_EVENT_TYPES
from kimi_cli.config import Config

def test_parse_hook_def():
    h = HookDef(event="PreToolUse", command="echo ok", matcher="Shell")
    assert h.event == "PreToolUse"
    assert h.timeout == 30

def test_default_matcher_is_empty():
    h = HookDef(event="Stop", command="echo done")
    assert h.matcher == ""

def test_invalid_event():
    with pytest.raises(Exception):
        HookDef(event="InvalidEvent", command="echo bad")

def test_all_event_types_defined():
    assert len(HOOK_EVENT_TYPES) == 13

def test_config_with_hooks():
    toml_str = '''
default_model = ""

[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "echo ok"
timeout = 10

[[hooks]]
event = "PostToolUse"
matcher = "WriteFile"
command = "prettier --write"
'''
    data = tomlkit.parse(toml_str)
    config = Config.model_validate(data)
    assert len(config.hooks) == 2
    assert config.hooks[0].event == "PreToolUse"
    assert config.hooks[0].matcher == "Shell"
    assert config.hooks[1].timeout == 30  # default

def test_config_without_hooks():
    config = Config.model_validate({"default_model": ""})
    assert config.hooks == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/hooks/test_config.py -v`

- [ ] **Step 3: Implement config models**

```python
# src/kimi_cli/hooks/__init__.py
from kimi_cli.hooks.config import HookDef, HookEventType, HOOK_EVENT_TYPES

__all__ = ["HookDef", "HookEventType", "HOOK_EVENT_TYPES"]
```

```python
# src/kimi_cli/hooks/config.py
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

HookEventType = Literal[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "UserPromptSubmit",
    "Stop",
    "StopFailure",
    "SessionStart",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "Notification",
]

HOOK_EVENT_TYPES: list[str] = list(HookEventType.__args__)  # type: ignore[attr-defined]


class HookDef(BaseModel):
    """A single hook definition in config.toml."""

    event: HookEventType
    """Which lifecycle event triggers this hook."""
    command: str
    """Shell command to execute. Receives JSON on stdin."""
    matcher: str = ""
    """Regex pattern to filter. Empty matches everything."""
    timeout: int = Field(default=30, ge=1, le=600)
    """Timeout in seconds. Fail-open on timeout."""
```

- [ ] **Step 4: Add `hooks` field to `Config`**

In `src/kimi_cli/config.py`, add to `Config` class (after line 204 `mcp` field):

```python
hooks: list[HookDef] = Field(default_factory=list, description="Hook definitions")
```

Add import at top:
```python
from kimi_cli.hooks.config import HookDef
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/hooks/test_config.py -v`

- [ ] **Step 6: Commit**

```bash
git add src/kimi_cli/hooks/__init__.py src/kimi_cli/hooks/config.py src/kimi_cli/config.py tests/hooks/test_config.py
git commit -m "feat(hooks): add hook config models and integrate into Config"
```

---

### Task 2: Hook Runner

**Files:**
- Create: `src/kimi_cli/hooks/runner.py`
- Test: `tests/hooks/test_runner.py`

- [ ] **Step 1: Write runner test**

```python
# tests/hooks/test_runner.py
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
    cmd = '''echo '{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "use rg"}}' '''
    result = await run_hook(cmd, {"tool_name": "Bash"}, timeout=5)
    assert result.action == "block"
    assert result.reason == "use rg"

@pytest.mark.asyncio
async def test_stdin_receives_json():
    cmd = """python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tool_name'])" """
    result = await run_hook(cmd, {"tool_name": "WriteFile"}, timeout=5)
    assert result.stdout.strip() == "WriteFile"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/hooks/test_runner.py -v`

- [ ] **Step 3: Implement runner**

```python
# src/kimi_cli/hooks/runner.py
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Literal

from kimi_cli.utils.logging import logger


@dataclass
class HookResult:
    """Result of a single hook execution."""
    action: Literal["allow", "block"] = "allow"
    reason: str = ""
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0
    timed_out: bool = False


async def run_hook(
    command: str,
    input_data: dict[str, Any],
    *,
    timeout: int = 30,
    cwd: str | None = None,
) -> HookResult:
    """Execute a single hook command. Fail-open: errors/timeouts → allow."""
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(input=json.dumps(input_data).encode()),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            logger.warning("Hook timed out after {t}s: {cmd}", t=timeout, cmd=command)
            return HookResult(action="allow", timed_out=True)
    except Exception as e:
        logger.warning("Hook failed: {cmd}: {e}", cmd=command, e=e)
        return HookResult(action="allow", stderr=str(e))

    stdout = stdout_bytes.decode(errors="replace")
    stderr = stderr_bytes.decode(errors="replace")
    exit_code = proc.returncode or 0

    # Exit 2 = block
    if exit_code == 2:
        return HookResult(action="block", reason=stderr.strip(), stdout=stdout, stderr=stderr, exit_code=2)

    # Exit 0 + JSON stdout = structured decision
    if exit_code == 0 and stdout.strip():
        try:
            parsed = json.loads(stdout)
            if isinstance(parsed, dict):
                hook_output = parsed.get("hookSpecificOutput", {})
                if hook_output.get("permissionDecision") == "deny":
                    return HookResult(
                        action="block",
                        reason=hook_output.get("permissionDecisionReason", ""),
                        stdout=stdout, stderr=stderr, exit_code=0,
                    )
        except (json.JSONDecodeError, TypeError):
            pass

    return HookResult(action="allow", stdout=stdout, stderr=stderr, exit_code=exit_code)
```

- [ ] **Step 4: Run test**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/hooks/test_runner.py -v`

- [ ] **Step 5: Commit**

```bash
git add src/kimi_cli/hooks/runner.py tests/hooks/test_runner.py
git commit -m "feat(hooks): add hook runner with subprocess execution"
```

---

### Task 3: Hook Engine + Event Payloads

**Files:**
- Create: `src/kimi_cli/hooks/engine.py`
- Create: `src/kimi_cli/hooks/events.py`
- Test: `tests/hooks/test_engine.py`

- [ ] **Step 1: Write engine test**

```python
# tests/hooks/test_engine.py
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
    results = await engine.trigger("PreToolUse", matcher_value="Shell", input_data={"tool_name": "Shell"})
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
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement events.py**

```python
# src/kimi_cli/hooks/events.py
"""Input payload builders for each hook event type."""
from __future__ import annotations
from typing import Any


def _base(event: str, session_id: str, cwd: str) -> dict[str, Any]:
    return {"hook_event_name": event, "session_id": session_id, "cwd": cwd}


def pre_tool_use(*, session_id: str, cwd: str, tool_name: str, tool_input: dict, tool_call_id: str = "") -> dict[str, Any]:
    return {**_base("PreToolUse", session_id, cwd), "tool_name": tool_name, "tool_input": tool_input, "tool_call_id": tool_call_id}


def post_tool_use(*, session_id: str, cwd: str, tool_name: str, tool_input: dict, tool_output: str = "", tool_call_id: str = "") -> dict[str, Any]:
    return {**_base("PostToolUse", session_id, cwd), "tool_name": tool_name, "tool_input": tool_input, "tool_output": tool_output, "tool_call_id": tool_call_id}


def post_tool_use_failure(*, session_id: str, cwd: str, tool_name: str, tool_input: dict, error: str, tool_call_id: str = "") -> dict[str, Any]:
    return {**_base("PostToolUseFailure", session_id, cwd), "tool_name": tool_name, "tool_input": tool_input, "error": error, "tool_call_id": tool_call_id}


def user_prompt_submit(*, session_id: str, cwd: str, prompt: str) -> dict[str, Any]:
    return {**_base("UserPromptSubmit", session_id, cwd), "prompt": prompt}


def stop(*, session_id: str, cwd: str, stop_hook_active: bool = False) -> dict[str, Any]:
    return {**_base("Stop", session_id, cwd), "stop_hook_active": stop_hook_active}


def stop_failure(*, session_id: str, cwd: str, error_type: str, error_message: str) -> dict[str, Any]:
    return {**_base("StopFailure", session_id, cwd), "error_type": error_type, "error_message": error_message}


def session_start(*, session_id: str, cwd: str, source: str) -> dict[str, Any]:
    return {**_base("SessionStart", session_id, cwd), "source": source}


def session_end(*, session_id: str, cwd: str, reason: str) -> dict[str, Any]:
    return {**_base("SessionEnd", session_id, cwd), "reason": reason}


def subagent_start(*, session_id: str, cwd: str, agent_name: str, prompt: str) -> dict[str, Any]:
    return {**_base("SubagentStart", session_id, cwd), "agent_name": agent_name, "prompt": prompt}


def subagent_stop(*, session_id: str, cwd: str, agent_name: str, response: str = "") -> dict[str, Any]:
    return {**_base("SubagentStop", session_id, cwd), "agent_name": agent_name, "response": response}


def pre_compact(*, session_id: str, cwd: str, trigger: str, token_count: int) -> dict[str, Any]:
    return {**_base("PreCompact", session_id, cwd), "trigger": trigger, "token_count": token_count}


def post_compact(*, session_id: str, cwd: str, trigger: str, estimated_token_count: int) -> dict[str, Any]:
    return {**_base("PostCompact", session_id, cwd), "trigger": trigger, "estimated_token_count": estimated_token_count}


def notification(*, session_id: str, cwd: str, sink: str, notification_type: str, title: str = "", body: str = "", severity: str = "info") -> dict[str, Any]:
    return {**_base("Notification", session_id, cwd), "sink": sink, "notification_type": notification_type, "title": title, "body": body, "severity": severity}
```

- [ ] **Step 4: Implement engine.py**

```python
# src/kimi_cli/hooks/engine.py
from __future__ import annotations

import asyncio
import re
from typing import Any

from kimi_cli.hooks.config import HookDef, HookEventType, HOOK_EVENT_TYPES
from kimi_cli.hooks.runner import HookResult, run_hook
from kimi_cli.utils.logging import logger


class HookEngine:
    """Loads hook definitions and executes matching hooks in parallel."""

    def __init__(self, hooks: list[HookDef], cwd: str | None = None):
        self._hooks = hooks
        self._cwd = cwd
        # Index by event for fast lookup
        self._by_event: dict[str, list[HookDef]] = {}
        for h in hooks:
            self._by_event.setdefault(h.event, []).append(h)

    @property
    def has_hooks(self) -> bool:
        return bool(self._hooks)

    def has_hooks_for(self, event: HookEventType) -> bool:
        return bool(self._by_event.get(event))

    @property
    def summary(self) -> dict[str, int]:
        """Event → count of configured hooks."""
        return {event: len(hooks) for event, hooks in self._by_event.items()}

    async def trigger(
        self,
        event: HookEventType,
        *,
        matcher_value: str = "",
        input_data: dict[str, Any],
    ) -> list[HookResult]:
        """Run all matching hooks for an event in parallel. Dedup identical commands."""
        candidates = self._by_event.get(event, [])
        if not candidates:
            return []

        seen: set[str] = set()
        matched: list[HookDef] = []
        for h in candidates:
            if h.matcher:
                try:
                    if not re.search(h.matcher, matcher_value):
                        continue
                except re.error:
                    logger.warning("Invalid regex in hook matcher: {m}", m=h.matcher)
                    continue  # bad regex → skip this hook (fail-open)
            if h.command in seen:
                continue
            seen.add(h.command)
            matched.append(h)

        if not matched:
            return []

        logger.debug("Triggering {n} hooks for {event}", n=len(matched), event=event)
        tasks = [run_hook(h.command, input_data, timeout=h.timeout, cwd=self._cwd) for h in matched]
        return list(await asyncio.gather(*tasks))
```

- [ ] **Step 5: Run test**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/hooks/test_engine.py -v`

- [ ] **Step 6: Commit**

```bash
git add src/kimi_cli/hooks/engine.py src/kimi_cli/hooks/events.py tests/hooks/test_engine.py
git commit -m "feat(hooks): add hook engine with matching, dedup, and parallel execution"
```

---

### Task 4: Inject into KimiToolset (PreToolUse / PostToolUse / PostToolUseFailure)

**Files:**
- Modify: `src/kimi_cli/soul/toolset.py:73-141`

- [ ] **Step 1: Add hook engine to KimiToolset**

Add to `KimiToolset.__init__()`:

```python
self._hook_engine: HookEngine | None = None

def set_hook_engine(self, engine: HookEngine) -> None:
    self._hook_engine = engine
```

Import at top:
```python
from pathlib import Path
from kimi_cli.hooks.engine import HookEngine
```

- [ ] **Step 2: Wrap `_call()` with hooks**

Replace the `_call()` inner function in `handle()` (lines 130-137):

```python
async def _call():
    tool_input_dict = arguments if isinstance(arguments, dict) else {}

    # --- PreToolUse ---
    if self._hook_engine and self._hook_engine.has_hooks_for("PreToolUse"):
        from kimi_cli.hooks import events
        results = await self._hook_engine.trigger(
            "PreToolUse",
            matcher_value=tool_call.function.name,
            input_data=events.pre_tool_use(
                session_id=_get_session_id(),
                cwd=str(Path.cwd()),
                tool_name=tool_call.function.name,
                tool_input=tool_input_dict,
                tool_call_id=tool_call.id,
            ),
        )
        for r in results:
            if r.action == "block":
                return ToolResult(
                    tool_call_id=tool_call.id,
                    return_value=ToolError(
                        message=r.reason or "Blocked by PreToolUse hook",
                        brief="Hook blocked",
                    ),
                )

    # --- Execute tool ---
    try:
        ret = await tool.call(arguments)
    except Exception as e:
        # --- PostToolUseFailure ---
        if self._hook_engine and self._hook_engine.has_hooks_for("PostToolUseFailure"):
            from kimi_cli.hooks import events
            # Fire-and-forget, but store task ref to avoid GC
            _bg = asyncio.create_task(self._hook_engine.trigger(
                "PostToolUseFailure",
                matcher_value=tool_call.function.name,
                input_data=events.post_tool_use_failure(
                    session_id=_get_session_id(), cwd=str(Path.cwd()),
                    tool_name=tool_call.function.name,
                    tool_input=tool_input_dict, error=str(e),
                    tool_call_id=tool_call.id,
                ),
            ))
            _bg.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
        return ToolResult(tool_call_id=tool_call.id, return_value=ToolRuntimeError(str(e)))

    # --- PostToolUse ---
    if self._hook_engine and self._hook_engine.has_hooks_for("PostToolUse"):
        from kimi_cli.hooks import events
        _bg = asyncio.create_task(self._hook_engine.trigger(
            "PostToolUse",
            matcher_value=tool_call.function.name,
            input_data=events.post_tool_use(
                session_id=_get_session_id(), cwd=str(Path.cwd()),
                tool_name=tool_call.function.name,
                tool_input=tool_input_dict,
                tool_call_id=tool_call.id,
            ),
        ))
        _bg.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)

    return ToolResult(tool_call_id=tool_call.id, return_value=ret)
```

Add session_id helper using ContextVar (add at module level):

```python
from contextvars import ContextVar
_current_session_id: ContextVar[str] = ContextVar("_current_session_id", default="")

def set_session_id(sid: str) -> None:
    _current_session_id.set(sid)

def _get_session_id() -> str:
    return _current_session_id.get()
```

- [ ] **Step 3: Commit**

```bash
git add src/kimi_cli/soul/toolset.py
git commit -m "feat(hooks): inject PreToolUse/PostToolUse/PostToolUseFailure into tool execution"
```

---

### Task 5: Inject into KimiSoul (UserPromptSubmit, Stop, StopFailure, Compact, Notification)

**Files:**
- Modify: `src/kimi_cli/soul/kimisoul.py`

- [ ] **Step 1: Add hook engine to KimiSoul**

Add property and setter:

```python
self._hook_engine: HookEngine | None = None
self._stop_hook_active: bool = False

@property
def hook_engine(self) -> HookEngine | None:
    return self._hook_engine

def set_hook_engine(self, engine: HookEngine) -> None:
    self._hook_engine = engine
    if isinstance(self._agent.toolset, KimiToolset):
        self._agent.toolset.set_hook_engine(engine)
```

- [ ] **Step 2: UserPromptSubmit in `run()` (before line 425)**

```python
async def run(self, user_input: str | list[ContentPart]):
    await self._runtime.oauth.ensure_fresh(self._runtime)

    # --- UserPromptSubmit hook ---
    text_input_for_hook = user_input if isinstance(user_input, str) else ""
    if self._hook_engine and self._hook_engine.has_hooks_for("UserPromptSubmit"):
        from kimi_cli.hooks import events
        results = await self._hook_engine.trigger(
            "UserPromptSubmit",
            input_data=events.user_prompt_submit(
                session_id=self._runtime.session.id,
                cwd=str(Path.cwd()),
                prompt=text_input_for_hook,
            ),
        )
        for r in results:
            if r.action == "block":
                wire_send(TurnBegin(user_input=user_input))
                wire_send(TextPart(text=r.reason or "Prompt blocked by hook."))
                wire_send(TurnEnd())
                return

    wire_send(TurnBegin(user_input=user_input))
    # ... rest of run() unchanged ...
```

- [ ] **Step 3: Stop hook in `run()` (before `wire_send(TurnEnd())`)**

```python
    # --- Stop hook (max 1 re-trigger to prevent infinite loop) ---
    if not self._stop_hook_active and self._hook_engine and self._hook_engine.has_hooks_for("Stop"):
        from kimi_cli.hooks import events
        stop_results = await self._hook_engine.trigger(
            "Stop",
            input_data=events.stop(
                session_id=self._runtime.session.id,
                cwd=str(Path.cwd()),
                stop_hook_active=False,
            ),
        )
        for r in stop_results:
            if r.action == "block" and r.reason:
                self._stop_hook_active = True
                try:
                    await self._turn(Message(role="user", content=r.reason))
                finally:
                    self._stop_hook_active = False
                break

    wire_send(TurnEnd())
```

- [ ] **Step 4: Notification hook in `_step()` (wrap `deliver_pending` callback, around line 657)**

The real notification pipeline is `runtime.notifications.deliver_pending()` in `_step()`. Wrap the `on_notification` callback to also fire hooks:

```python
# In _step(), where deliver_pending is called (line 652-662):
if self._runtime.role == "root":
    async def _append_notification(view: NotificationView) -> None:
        await self._context.append_message(build_notification_message(view, self._runtime))
        # --- Notification hook ---
        if self._hook_engine and self._hook_engine.has_hooks_for("Notification"):
            from kimi_cli.hooks import events
            _bg = asyncio.create_task(self._hook_engine.trigger(
                "Notification",
                matcher_value=view.event.type,
                input_data=events.notification(
                    session_id=self._runtime.session.id,
                    cwd=str(Path.cwd()),
                    sink="llm",
                    notification_type=view.event.type,
                    title=view.event.title,
                    body=view.event.body,
                    severity=view.event.severity,
                ),
            ))
            _bg.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)

    await self._runtime.notifications.deliver_pending(
        "llm", limit=4,
        before_claim=self._runtime.background_tasks.reconcile,
        on_notification=_append_notification,
    )
```

- [ ] **Step 5: PreCompact/PostCompact in `compact_context()` (around lines 820, 847)**

Before `wire_send(CompactionBegin())`:

```python
trigger_reason = "manual" if custom_instruction else "auto"
if self._hook_engine and self._hook_engine.has_hooks_for("PreCompact"):
    from kimi_cli.hooks import events
    await self._hook_engine.trigger(
        "PreCompact", matcher_value=trigger_reason,
        input_data=events.pre_compact(
            session_id=self._runtime.session.id, cwd=str(Path.cwd()),
            trigger=trigger_reason, token_count=self._context.token_count,
        ),
    )
```

After `wire_send(CompactionEnd())`:

```python
if self._hook_engine and self._hook_engine.has_hooks_for("PostCompact"):
    from kimi_cli.hooks import events
    _bg = asyncio.create_task(self._hook_engine.trigger(
        "PostCompact", matcher_value=trigger_reason,
        input_data=events.post_compact(
            session_id=self._runtime.session.id, cwd=str(Path.cwd()),
            trigger=trigger_reason, estimated_token_count=estimated_token_count,
        ),
    ))
    _bg.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
```

- [ ] **Step 6: StopFailure in `_agent_loop()` (at line 612)**

In the `except Exception` block, before `raise`:

```python
except Exception as e:
    wire_send(StepInterrupted())
    # --- StopFailure hook ---
    if self._hook_engine and self._hook_engine.has_hooks_for("StopFailure"):
        from kimi_cli.hooks import events
        _bg = asyncio.create_task(self._hook_engine.trigger(
            "StopFailure",
            input_data=events.stop_failure(
                session_id=self._runtime.session.id, cwd=str(Path.cwd()),
                error_type=type(e).__name__, error_message=str(e),
            ),
        ))
        _bg.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
    raise
```

- [ ] **Step 7: Set session_id ContextVar in `run()`**

At the start of `run()`, after oauth refresh:

```python
from kimi_cli.soul.toolset import set_session_id
set_session_id(self._runtime.session.id)
```

- [ ] **Step 8: Commit**

```bash
git add src/kimi_cli/soul/kimisoul.py
git commit -m "feat(hooks): inject UserPromptSubmit, Stop, StopFailure, Compact, Notification hooks"
```

---

### Task 6: Inject into Subagent System (SubagentStart / SubagentStop)

**Files:**
- Modify: `src/kimi_cli/tools/multiagent/task.py:102-167`

- [ ] **Step 1: Add SubagentStart/SubagentStop hooks**

In `_run_subagent()`, around line 136. Note: `Task` has `self._session` (not `self._runtime`), and use `soul.hook_engine` (public property):

```python
# --- SubagentStart hook ---
hook_engine = soul.hook_engine  # public property added in Task 5
if hook_engine and hook_engine.has_hooks_for("SubagentStart"):
    from kimi_cli.hooks import events
    await hook_engine.trigger(
        "SubagentStart", matcher_value=agent.name,
        input_data=events.subagent_start(
            session_id=self._session.id, cwd=str(Path.cwd()),
            agent_name=agent.name, prompt=prompt[:500],
        ),
    )

await run_soul(soul, prompt, _ui_loop_fn, asyncio.Event(), runtime=soul.runtime)

# --- SubagentStop hook ---
if hook_engine and hook_engine.has_hooks_for("SubagentStop"):
    from kimi_cli.hooks import events
    final = context.history[-1].extract_text(sep="\n")[:500] if context.history else ""
    _bg = asyncio.create_task(hook_engine.trigger(
        "SubagentStop", matcher_value=agent.name,
        input_data=events.subagent_stop(
            session_id=self._session.id, cwd=str(Path.cwd()),
            agent_name=agent.name, response=final,
        ),
    ))
    _bg.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
```

- [ ] **Step 2: Commit**

```bash
git add src/kimi_cli/tools/multiagent/task.py
git commit -m "feat(hooks): inject SubagentStart/SubagentStop hooks"
```

---

### Task 7: Session Hooks + Wire Integration

**Files:**
- Modify: `src/kimi_cli/app.py:211-212` (create HookEngine after KimiSoul)
- Modify: `src/kimi_cli/cli/__init__.py:486-570` (SessionStart/SessionEnd where new/resume is known)
- Modify: `src/kimi_cli/wire/server.py:322-380` (hooks in initialize response)
- Modify: `src/kimi_cli/wire/protocol.py` (bump version)

- [ ] **Step 1: Create HookEngine in app.py (KimiCLI.create)**

After `KimiSoul` is created (line 211-212), inject hook engine. Note: `KimiCLI.create()` does NOT know whether the session is new or resumed — that's the caller's job (Step 2).

```python
# app.py, after line 211: soul = KimiSoul(agent, context=context)
from kimi_cli.hooks.engine import HookEngine

hook_engine = HookEngine(resolved_config.hooks, cwd=str(session.work_dir))
soul.set_hook_engine(hook_engine)

return KimiCLI(soul, runtime, env_overrides)
```

- [ ] **Step 2: SessionStart/SessionEnd in cli/__init__.py**

The `cli/__init__.py:486-504` is the ONLY place that knows whether the session is new vs resumed. Add hooks there:

```python
# cli/__init__.py, after line 504 (session is created/found/continued):
# Determine session source
if continue_:
    _session_source = "resume"
elif session_id is not None and session is not None:
    # Session.find succeeded → resume; Session.create → startup
    _session_source = "resume" if await Session.find(work_dir, session_id) else "startup"
else:
    _session_source = "startup"

# ... KimiCLI.create() at line 529 ...

# After line 543 (instance is created):
# --- SessionStart hook ---
if instance.soul.hook_engine and instance.soul.hook_engine.has_hooks_for("SessionStart"):
    from kimi_cli.hooks import events
    await instance.soul.hook_engine.trigger(
        "SessionStart", matcher_value=_session_source,
        input_data=events.session_start(
            session_id=session.id,
            cwd=str(work_dir),
            source=_session_source,
        ),
    )
```

For SessionEnd, use the `finally` block (line 549+) which ALL UI modes hit:

```python
# cli/__init__.py, in the finally block around line 575+:
finally:
    # --- SessionEnd hook ---
    if instance.soul.hook_engine and instance.soul.hook_engine.has_hooks_for("SessionEnd"):
        from kimi_cli.hooks import events
        try:
            await asyncio.wait_for(
                instance.soul.hook_engine.trigger(
                    "SessionEnd",
                    input_data=events.session_end(
                        session_id=session.id,
                        cwd=str(work_dir),
                        reason="exit",
                    ),
                ),
                timeout=5,
            )
        except Exception:
            logger.warning("SessionEnd hook failed")
    if not preserve_background_tasks:
        instance.shutdown_background_tasks()
```

- [ ] **Step 3: Add hooks metadata to initialize response**

In `wire/server.py _handle_initialize`, add to the `result` dict:

```python
from kimi_cli.hooks.config import HOOK_EVENT_TYPES

if isinstance(self._soul, KimiSoul) and self._soul.hook_engine:
    result["hooks"] = cast(JsonType, {
        "supported_events": HOOK_EVENT_TYPES,
        "configured": self._soul.hook_engine.summary,
    })
```

- [ ] **Step 4: Bump wire protocol version**

In `src/kimi_cli/wire/protocol.py`:

```python
WIRE_PROTOCOL_VERSION: str = "1.6"
```

- [ ] **Step 5: Commit**

```bash
git add src/kimi_cli/app.py src/kimi_cli/cli/__init__.py src/kimi_cli/wire/server.py src/kimi_cli/wire/protocol.py
git commit -m "feat(hooks): SessionStart/End in cli entrypoint + wire protocol hooks metadata"
```

---

### Task 8: `/hooks` Shell Command

**Files:**
- Modify: `src/kimi_cli/ui/shell/slash.py`

- [ ] **Step 1: Register `/hooks` command**

Add a shell-level slash command (using the correct shell command signature):

```python
@shell_slash_command
def hooks(app, args: str) -> None:
    """View configured hooks."""
    from kimi_cli.soul.kimisoul import KimiSoul

    soul = app.soul
    if not isinstance(soul, KimiSoul) or soul.hook_engine is None or not soul.hook_engine.has_hooks:
        console.print("[yellow]No hooks configured.[/yellow]")
        console.print("[grey50]Add [[hooks]] entries to your config.toml.[/grey50]")
        return

    engine = soul.hook_engine
    console.print("[bold]Configured Hooks:[/bold]\n")
    for event, count in engine.summary.items():
        console.print(f"  [cyan]{event}[/cyan]: {count} hook(s)")
```

- [ ] **Step 2: Commit**

```bash
git add src/kimi_cli/ui/shell/slash.py
git commit -m "feat(hooks): add /hooks command to list configured hooks"
```

---

### Task 9: Integration Tests

**Files:**
- Create: `tests/hooks/test_integration.py`

- [ ] **Step 1: Write integration test**

```python
# tests/hooks/test_integration.py
import json
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

        # Safe command → allow
        results = await engine.trigger(
            "PreToolUse", matcher_value="Shell",
            input_data={"tool_name": "Shell", "tool_input": {"command": "ls -la"}},
        )
        assert all(r.action == "allow" for r in results)

        # Dangerous command → block
        results = await engine.trigger(
            "PreToolUse", matcher_value="Shell",
            input_data={"tool_name": "Shell", "tool_input": {"command": "rm -rf /"}},
        )
        assert any(r.action == "block" for r in results)

@pytest.mark.asyncio
async def test_stop_hook_feedback():
    """Stop hook returns block with reason."""
    hooks = [HookDef(event="Stop", command='echo \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"tests not written"}}\' ', timeout=5)]
    engine = HookEngine(hooks)

    results = await engine.trigger("Stop", input_data={"stop_hook_active": False})
    assert len(results) == 1
    assert results[0].action == "block"
    assert "tests not written" in results[0].reason

def test_config_roundtrip_toml():
    """Hooks survive TOML serialize/deserialize."""
    toml_str = '''
[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "echo ok"

[[hooks]]
event = "Notification"
matcher = "permission_prompt"
command = "notify-send 'Kimi'"
timeout = 5
'''
    from kimi_cli.config import Config
    data = tomlkit.parse(toml_str)
    data["default_model"] = ""
    config = Config.model_validate(data)
    assert len(config.hooks) == 2
    assert config.hooks[0].event == "PreToolUse"
    assert config.hooks[1].event == "Notification"
    assert config.hooks[1].timeout == 5
```

- [ ] **Step 2: Run all hook tests**

Run: `cd /Users/moonshot/Projects/kimi-cli && python -m pytest tests/hooks/ -v`

- [ ] **Step 3: Commit**

```bash
git add tests/hooks/test_integration.py
git commit -m "test(hooks): add integration tests for blocking, stop feedback, and TOML roundtrip"
```

---

## Design Decisions

1. **Fail-open everywhere**: Hooks that timeout, crash, or have invalid regex matchers → allow/skip. Never block agent on hook failures.
2. **`config.toml`**: Hooks live in existing config, not a new `settings.json`. Flat `[[hooks]]` format is the most natural TOML representation.
3. **PreToolUse is synchronous**: Must complete before tool runs. PostToolUse/PostToolUseFailure/Notification are fire-and-forget (task refs stored to avoid GC).
4. **Stop re-loop guard**: `_stop_hook_active` flag prevents infinite loops. Max 1 re-trigger per turn. The hook receives `stop_hook_active=true` on the re-triggered run so it can also exit early on its side.
5. **Parallel execution**: Multiple hooks for the same event run via `asyncio.gather`. Identical commands are deduped.
6. **Session ID via ContextVar**: Avoids threading session_id through every toolset call.
7. **Wire protocol 1.6**: `initialize` response includes `hooks.supported_events` (list) and `hooks.configured` (event→count map).
8. **Phase 1 scope**: Only `command` type. `http`/`prompt`/`agent` types are Phase 2.
9. **Session hooks in cli entrypoint**: `SessionStart`/`SessionEnd` are in `cli/__init__.py` (not `app.py` or `WireServer`), because only the CLI entrypoint knows whether a session is new vs resumed, and the `finally` block there is hit by ALL UI modes (shell/print/acp/wire).
10. **Notification hooks on real notification pipeline**: Hooks fire inside `deliver_pending()` callback in `_step()`, not on the approval flow. This catches ALL notification types (task completion, background events, etc.), not just approval prompts.
11. **Invalid regex → skip hook**: Bad regex in matcher causes that specific hook to be skipped with a warning, not the entire event to fail.

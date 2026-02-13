from __future__ import annotations

from datetime import datetime

from kimi_cli.hooks.models import (
    HookDecision,
    HookEvent,
    HookResult,
    SubagentHookEvent,
    ToolHookEvent,
)


class TestHookDecision:
    def test_enum_values(self):
        assert HookDecision.ALLOW.value == "allow"
        assert HookDecision.DENY.value == "deny"
        assert HookDecision.ASK.value == "ask"


class TestHookEvent:
    def test_basic_creation(self):
        event = HookEvent(
            event_type="session_start",
            timestamp=datetime.now(),
            session_id="sess_123",
            work_dir="/home/user/project",
        )
        assert event.event_type == "session_start"
        assert event.session_id == "sess_123"
        assert event.work_dir == "/home/user/project"
        assert event.context == {}

    def test_with_context(self):
        event = HookEvent(
            event_type="session_start",
            timestamp=datetime.now(),
            session_id="sess_123",
            work_dir="/home/user/project",
            context={"extra": "data", "number": 42},
        )
        assert event.context == {"extra": "data", "number": 42}


class TestToolHookEvent:
    def test_basic_creation(self):
        event = ToolHookEvent(
            event_type="before_tool",
            timestamp=datetime.now(),
            session_id="sess_123",
            work_dir="/home/user/project",
            tool_name="Shell",
            tool_input={"command": "ls -la"},
        )
        assert event.event_type == "before_tool"
        assert event.tool_name == "Shell"
        assert event.tool_input == {"command": "ls -la"}
        assert event.tool_use_id is None

    def test_with_tool_use_id(self):
        event = ToolHookEvent(
            event_type="before_tool",
            timestamp=datetime.now(),
            session_id="sess_123",
            work_dir="/home/user/project",
            tool_name="Shell",
            tool_input={"command": "ls -la"},
            tool_use_id="tool_abc123",
        )
        assert event.tool_use_id == "tool_abc123"


class TestSubagentHookEvent:
    def test_basic_creation(self):
        event = SubagentHookEvent(
            event_type="subagent_start",
            timestamp=datetime.now(),
            session_id="sess_123",
            work_dir="/home/user/project",
            subagent_name="coder",
        )
        assert event.event_type == "subagent_start"
        assert event.subagent_name == "coder"
        assert event.subagent_type is None
        assert event.task_description is None

    def test_full_creation(self):
        event = SubagentHookEvent(
            event_type="subagent_start",
            timestamp=datetime.now(),
            session_id="sess_123",
            work_dir="/home/user/project",
            subagent_name="coder",
            subagent_type="python",
            task_description="Refactor the code",
        )
        assert event.subagent_type == "python"
        assert event.task_description == "Refactor the code"


class TestHookResult:
    def test_basic_success(self):
        result = HookResult(
            success=True,
            hook_name="test-hook",
            hook_type="command",
            duration_ms=100,
        )
        assert result.success is True
        assert result.hook_name == "test-hook"
        assert result.hook_type == "command"
        assert result.duration_ms == 100
        assert result.decision == HookDecision.ALLOW  # Default

    def test_with_decision(self):
        result = HookResult(
            success=True,
            hook_name="block-hook",
            hook_type="command",
            duration_ms=50,
            decision=HookDecision.DENY,
            reason="Dangerous command detected",
        )
        assert result.decision == HookDecision.DENY
        assert result.reason == "Dangerous command detected"

    def test_with_modified_input(self):
        result = HookResult(
            success=True,
            hook_name="modify-hook",
            hook_type="command",
            duration_ms=75,
            modified_input={"command": "modified"},
        )
        assert result.modified_input == {"command": "modified"}

    def test_with_additional_context(self):
        result = HookResult(
            success=True,
            hook_name="context-hook",
            hook_type="command",
            duration_ms=60,
            additional_context="Extra information from hook",
        )
        assert result.additional_context == "Extra information from hook"

    def test_with_exit_code(self):
        result = HookResult(
            success=True,
            hook_name="command-hook",
            hook_type="command",
            duration_ms=80,
            exit_code=2,
            stderr="Error message",
        )
        assert result.exit_code == 2
        assert result.stderr == "Error message"

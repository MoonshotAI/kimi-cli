from __future__ import annotations

import pytest
from pydantic import ValidationError

from kimi_cli.hooks.config import (
    CommandHookConfig,
    HookEventType,
    HookMatcher,
    HooksConfig,
    HookType,
)


class TestHookEventType:
    def test_enum_values(self):
        assert HookEventType.SESSION_START.value == "session_start"
        assert HookEventType.SESSION_END.value == "session_end"
        assert HookEventType.BEFORE_AGENT.value == "before_agent"
        assert HookEventType.AFTER_AGENT.value == "after_agent"
        assert HookEventType.BEFORE_TOOL.value == "before_tool"
        assert HookEventType.AFTER_TOOL.value == "after_tool"
        assert HookEventType.AFTER_TOOL_FAILURE.value == "after_tool_failure"
        assert HookEventType.SUBAGENT_START.value == "subagent_start"
        assert HookEventType.SUBAGENT_STOP.value == "subagent_stop"
        assert HookEventType.PRE_COMPACT.value == "pre_compact"


class TestHookType:
    def test_enum_values(self):
        assert HookType.COMMAND.value == "command"


class TestHookMatcher:
    def test_matches_no_constraints(self):
        matcher = HookMatcher()
        assert matcher.matches() is True
        assert matcher.matches("Shell", {}) is True

    def test_matches_tool_pattern(self):
        matcher = HookMatcher(tool="Shell")
        assert matcher.matches("Shell", {}) is True
        assert matcher.matches("WriteFile", {}) is False

    def test_matches_tool_regex(self):
        matcher = HookMatcher(tool="Shell|WriteFile")
        assert matcher.matches("Shell", {}) is True
        assert matcher.matches("WriteFile", {}) is True
        assert matcher.matches("ReadFile", {}) is False

    def test_matches_arguments_pattern(self):
        matcher = HookMatcher(pattern="rm -rf")
        assert matcher.matches("Shell", {"command": "rm -rf /tmp"}) is True
        assert matcher.matches("Shell", {"command": "ls -la"}) is False

    def test_matches_both(self):
        matcher = HookMatcher(tool="Shell", pattern="rm -rf")
        assert matcher.matches("Shell", {"command": "rm -rf /tmp"}) is True
        assert matcher.matches("WriteFile", {"command": "rm -rf /tmp"}) is False
        assert matcher.matches("Shell", {"command": "ls -la"}) is False


class TestCommandHookConfig:
    def test_basic_creation(self):
        hook = CommandHookConfig(command="echo hello")
        assert hook.command == "echo hello"
        assert hook.type == HookType.COMMAND
        assert hook.async_ is False
        assert hook.timeout == 30000

    def test_with_all_fields(self):
        hook = CommandHookConfig(
            name="test-hook",
            command="echo hello",
            timeout=5000,
            description="Test hook",
            async_=True,
            matcher=HookMatcher(tool="Shell"),
        )
        assert hook.name == "test-hook"
        assert hook.command == "echo hello"
        assert hook.timeout == 5000
        assert hook.description == "Test hook"
        # Note: async_ is set via alias, pydantic stores it correctly
        assert hook.model_dump(by_alias=True)["async"] is True
        assert hook.matcher.tool == "Shell"

    def test_timeout_validation(self):
        with pytest.raises(ValidationError):
            CommandHookConfig(command="echo hello", timeout=50)  # Too low

        with pytest.raises(ValidationError):
            CommandHookConfig(command="echo hello", timeout=700000)  # Too high

        # Valid boundaries
        CommandHookConfig(command="echo hello", timeout=100)
        CommandHookConfig(command="echo hello", timeout=600000)

    def test_async_alias(self):
        # Test that 'async' alias works
        hook = CommandHookConfig(command="echo hello", **{"async": True})
        assert hook.async_ is True


class TestHooksConfig:
    def test_default_empty(self):
        config = HooksConfig()
        assert config.session_start == []
        assert config.session_end == []
        assert config.before_agent == []
        assert config.after_agent == []
        assert config.before_tool == []
        assert config.after_tool == []
        assert config.after_tool_failure == []
        assert config.subagent_start == []
        assert config.subagent_stop == []
        assert config.pre_compact == []

    def test_auto_assign_names(self):
        config = HooksConfig(
            before_tool=[
                CommandHookConfig(command="echo 1"),
                CommandHookConfig(command="echo 2"),
            ]
        )
        assert config.before_tool[0].name == "before_tool_0"
        assert config.before_tool[1].name == "before_tool_1"

    def test_preserves_custom_names(self):
        config = HooksConfig(
            before_tool=[
                CommandHookConfig(name="custom-hook", command="echo hello"),
            ]
        )
        assert config.before_tool[0].name == "custom-hook"

    def test_multiple_event_types(self):
        config = HooksConfig(
            session_start=[CommandHookConfig(command="echo start")],
            session_end=[CommandHookConfig(command="echo end")],
            before_tool=[CommandHookConfig(command="echo before")],
        )
        assert len(config.session_start) == 1
        assert len(config.session_end) == 1
        assert len(config.before_tool) == 1

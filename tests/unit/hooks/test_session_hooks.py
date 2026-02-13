"""Tests for session lifecycle hooks (FEAT-0002)."""

from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kimi_cli.hooks.config import CommandHookConfig, HookEventType, HooksConfig
from kimi_cli.hooks.manager import HookManager
from kimi_cli.hooks.models import (
    HookDecision,
    HookResult,
    SessionEndHookEvent,
    SessionStartHookEvent,
)


class TestSessionStartHookEvent:
    """Test SessionStartHookEvent model."""

    def test_basic_creation(self):
        """Test basic creation of SessionStartHookEvent."""
        event = SessionStartHookEvent(
            event_type="session_start",
            timestamp=datetime.now(),
            session_id="sess_123",
            work_dir="/home/user/project",
        )
        assert event.event_type == "session_start"
        assert event.session_id == "sess_123"
        assert event.work_dir == "/home/user/project"
        assert event.model is None
        assert event.args == {}

    def test_full_creation(self):
        """Test creation with all fields."""
        now = datetime.now()
        event = SessionStartHookEvent(
            event_type="session_start",
            timestamp=now,
            session_id="sess_456",
            work_dir="/home/user/project",
            model="kimi-k2",
            args={"yolo": True, "thinking": False},
            context={"extra": "data"},
        )
        assert event.model == "kimi-k2"
        assert event.args == {"yolo": True, "thinking": False}
        assert event.context == {"extra": "data"}


class TestSessionEndHookEvent:
    """Test SessionEndHookEvent model."""

    def test_basic_creation(self):
        """Test basic creation of SessionEndHookEvent."""
        event = SessionEndHookEvent(
            event_type="session_end",
            timestamp=datetime.now(),
            session_id="sess_123",
            work_dir="/home/user/project",
        )
        assert event.event_type == "session_end"
        assert event.session_id == "sess_123"
        assert event.duration_seconds == 0
        assert event.total_steps == 0
        assert event.exit_reason == "user_exit"

    def test_full_creation(self):
        """Test creation with all fields."""
        now = datetime.now()
        event = SessionEndHookEvent(
            event_type="session_end",
            timestamp=now,
            session_id="sess_789",
            work_dir="/home/user/project",
            duration_seconds=3600,
            total_steps=42,
            exit_reason="error",
        )
        assert event.duration_seconds == 3600
        assert event.total_steps == 42
        assert event.exit_reason == "error"


class TestSessionHooksIntegration:
    """Integration tests for session lifecycle hooks."""

    @pytest.mark.asyncio
    async def test_session_start_hook_execution(self):
        """Test that session_start hooks are executed."""
        config = HooksConfig(
            session_start=[
                CommandHookConfig(
                    name="test_start_hook",
                    command='echo \'{"additional_context": "Git branch: main"}\'',
                )
            ]
        )

        manager = HookManager(config)

        event = SessionStartHookEvent(
            event_type=HookEventType.SESSION_START.value,
            timestamp=datetime.now(),
            session_id="sess_test",
            work_dir="/tmp",
        )

        results = await manager.execute(HookEventType.SESSION_START, event)

        assert len(results) == 1
        assert results[0].success is True
        assert results[0].additional_context == "Git branch: main"

    @pytest.mark.asyncio
    async def test_session_end_hook_execution(self):
        """Test that session_end hooks are executed."""
        config = HooksConfig(
            session_end=[
                CommandHookConfig(
                    name="test_end_hook",
                    command='echo \'{"decision": "allow"}\'',
                )
            ]
        )

        manager = HookManager(config)

        event = SessionEndHookEvent(
            event_type=HookEventType.SESSION_END.value,
            timestamp=datetime.now(),
            session_id="sess_test",
            work_dir="/tmp",
            duration_seconds=1800,
            total_steps=100,
            exit_reason="user_exit",
        )

        results = await manager.execute(HookEventType.SESSION_END, event)

        assert len(results) == 1
        assert results[0].success is True

    @pytest.mark.asyncio
    async def test_session_start_hook_fail_open(self):
        """Test that session_start hooks fail open on error."""
        config = HooksConfig(
            session_start=[
                CommandHookConfig(
                    name="failing_hook",
                    command="exit 1",  # Command fails
                )
            ]
        )

        manager = HookManager(config)

        event = SessionStartHookEvent(
            event_type=HookEventType.SESSION_START.value,
            timestamp=datetime.now(),
            session_id="sess_test",
            work_dir="/tmp",
        )

        results = await manager.execute(HookEventType.SESSION_START, event)

        # Should not raise, should return result with success=False
        assert len(results) == 1
        assert results[0].success is False
        assert results[0].decision == HookDecision.ALLOW  # Fail open

    @pytest.mark.asyncio
    async def test_multiple_session_hooks(self):
        """Test multiple session hooks execution."""
        config = HooksConfig(
            session_start=[
                CommandHookConfig(
                    name="hook1",
                    command='echo \'{"additional_context": "Context 1"}\'',
                ),
                CommandHookConfig(
                    name="hook2",
                    command='echo \'{"additional_context": "Context 2"}\'',
                ),
            ]
        )

        manager = HookManager(config)

        event = SessionStartHookEvent(
            event_type=HookEventType.SESSION_START.value,
            timestamp=datetime.now(),
            session_id="sess_test",
            work_dir="/tmp",
        )

        results = await manager.execute(HookEventType.SESSION_START, event)

        assert len(results) == 2
        contexts = [r.additional_context for r in results if r.additional_context]
        assert "Context 1" in contexts
        assert "Context 2" in contexts

    @pytest.mark.asyncio
    async def test_session_hook_timeout(self):
        """Test session hook timeout handling."""
        config = HooksConfig(
            session_start=[
                CommandHookConfig(
                    name="slow_hook",
                    command="sleep 10",  # Will timeout
                    timeout=100,  # 100ms timeout
                )
            ]
        )

        manager = HookManager(config)

        event = SessionStartHookEvent(
            event_type=HookEventType.SESSION_START.value,
            timestamp=datetime.now(),
            session_id="sess_test",
            work_dir="/tmp",
        )

        results = await manager.execute(HookEventType.SESSION_START, event)

        assert len(results) == 1
        assert results[0].success is False  # Timed out
        assert results[0].decision == HookDecision.ALLOW  # Fail open
        assert "timed out" in results[0].reason.lower()


class TestRuntimeSessionHooks:
    """Test Runtime integration with session hooks."""

    @pytest.mark.asyncio
    async def test_runtime_has_hook_manager(self):
        """Test that Runtime has hook_manager attribute."""
        # Import here to avoid circular imports
        from dataclasses import dataclass

        from kimi_cli.soul.agent import Runtime

        # Check that Runtime dataclass has the expected fields
        assert hasattr(Runtime, '__dataclass_fields__')
        fields = Runtime.__dataclass_fields__
        assert 'hook_manager' in fields
        assert '_session_start_time' in fields
        assert '_total_steps' in fields
        assert '_hook_env_vars' in fields

    def test_session_event_types_exist(self):
        """Test that session event types are defined."""
        assert HookEventType.SESSION_START.value == "session_start"
        assert HookEventType.SESSION_END.value == "session_end"

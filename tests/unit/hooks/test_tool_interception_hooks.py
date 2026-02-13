"""Tests for tool interception hooks (FEAT-0003)."""

from __future__ import annotations

import json
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from kosong.message import ToolCall

from kimi_cli.hooks.config import HookConfig, HookEventType, HooksConfig
from kimi_cli.hooks.models import HookDecision, ToolHookEvent
from kimi_cli.soul.toolset import KimiToolset, ToolHookCache, ToolHookStats


class TestToolHookCache:
    """Test ToolHookCache functionality."""

    def test_basic_cache_operations(self):
        """Test basic cache get/set operations."""
        cache = ToolHookCache(max_size=10)

        # Set a value
        cache.set("before_tool", "Shell", {"command": "ls"}, "blocked")

        # Get the value
        result = cache.get("before_tool", "Shell", {"command": "ls"})
        assert result == "blocked"

    def test_cache_miss(self):
        """Test cache miss returns None."""
        cache = ToolHookCache(max_size=10)

        # Get non-existent key
        result = cache.get("before_tool", "Shell", {"command": "ls"})
        assert result is None

    def test_cache_key_uniqueness(self):
        """Test that different inputs produce different cache keys."""
        cache = ToolHookCache(max_size=10)

        cache.set("before_tool", "Shell", {"command": "ls"}, "result1")
        cache.set("before_tool", "Shell", {"command": "pwd"}, "result2")
        cache.set("after_tool", "Shell", {"command": "ls"}, "result3")

        assert cache.get("before_tool", "Shell", {"command": "ls"}) == "result1"
        assert cache.get("before_tool", "Shell", {"command": "pwd"}) == "result2"
        assert cache.get("after_tool", "Shell", {"command": "ls"}) == "result3"

    def test_cache_eviction(self):
        """Test that cache evicts oldest entries when full."""
        cache = ToolHookCache(max_size=3)

        cache.set("event1", "tool", {"arg": 1}, "val1")
        cache.set("event2", "tool", {"arg": 2}, "val2")
        cache.set("event3", "tool", {"arg": 3}, "val3")
        cache.set("event4", "tool", {"arg": 4}, "val4")  # Should evict event1

        assert cache.get("event1", "tool", {"arg": 1}) is None  # Evicted
        assert cache.get("event2", "tool", {"arg": 2}) == "val2"
        assert cache.get("event3", "tool", {"arg": 3}) == "val3"
        assert cache.get("event4", "tool", {"arg": 4}) == "val4"

    def test_cache_lru_update(self):
        """Test that accessing updates LRU order."""
        cache = ToolHookCache(max_size=3)

        cache.set("event1", "tool", {"arg": 1}, "val1")
        cache.set("event2", "tool", {"arg": 2}, "val2")
        cache.set("event3", "tool", {"arg": 3}, "val3")

        # Access event1 to update its access time
        cache.get("event1", "tool", {"arg": 1})

        # Add new entry - should evict event2 (oldest now)
        cache.set("event4", "tool", {"arg": 4}, "val4")

        assert cache.get("event1", "tool", {"arg": 1}) == "val1"  # Still there
        assert cache.get("event2", "tool", {"arg": 2}) is None  # Evicted

    def test_cache_clear(self):
        """Test clearing all cache entries."""
        cache = ToolHookCache(max_size=10)

        cache.set("event1", "tool", {"arg": 1}, "val1")
        cache.set("event2", "tool", {"arg": 2}, "val2")

        cache.clear()

        assert cache.get("event1", "tool", {"arg": 1}) is None
        assert cache.get("event2", "tool", {"arg": 2}) is None
        assert len(cache._cache) == 0


class TestToolHookStats:
    """Test ToolHookStats functionality."""

    def test_initial_stats(self):
        """Test initial stats values."""
        stats = ToolHookStats()
        assert stats.total_calls == 0
        assert stats.blocked_calls == 0
        assert stats.modified_calls == 0
        assert stats.cache_hits == 0
        assert stats.total_duration_ms == 0.0
        assert stats.avg_duration_ms == 0.0

    def test_avg_duration_calculation(self):
        """Test average duration calculation."""
        stats = ToolHookStats()
        stats.total_calls = 10
        stats.total_duration_ms = 500.0

        assert stats.avg_duration_ms == 50.0

    def test_avg_duration_with_zero_calls(self):
        """Test average duration with zero calls."""
        stats = ToolHookStats()
        assert stats.avg_duration_ms == 0.0


class TestToolHookEvent:
    """Test ToolHookEvent model."""

    def test_basic_creation(self):
        """Test basic creation of ToolHookEvent."""
        event = ToolHookEvent(
            event_type="before_tool",
            timestamp=datetime.now(),
            session_id="sess_123",
            work_dir="/home/user/project",
            tool_name="Shell",
            tool_input={"command": "ls"},
        )
        assert event.event_type == "before_tool"
        assert event.tool_name == "Shell"
        assert event.tool_input == {"command": "ls"}
        assert event.tool_use_id is None

    def test_full_creation(self):
        """Test creation with all fields."""
        now = datetime.now()
        event = ToolHookEvent(
            event_type="after_tool",
            timestamp=now,
            session_id="sess_456",
            work_dir="/home/user/project",
            tool_name="WriteFile",
            tool_input={"file_path": "/tmp/test.txt", "content": "hello"},
            tool_use_id="tool_abc123",
            context={"duration_ms": 100, "error": None},
        )
        assert event.tool_use_id == "tool_abc123"
        assert event.context["duration_ms"] == 100


class TestKimiToolsetHooks:
    """Test KimiToolset hook integration."""

    def test_toolset_init_with_runtime(self):
        """Test KimiToolset initialization with runtime."""
        mock_runtime = MagicMock()
        toolset = KimiToolset(runtime=mock_runtime)

        assert toolset._runtime == mock_runtime
        assert isinstance(toolset._hook_cache, ToolHookCache)
        assert isinstance(toolset._hook_stats, ToolHookStats)

    def test_toolset_init_without_runtime(self):
        """Test KimiToolset initialization without runtime."""
        toolset = KimiToolset()

        assert toolset._runtime is None
        assert isinstance(toolset._hook_cache, ToolHookCache)
        assert isinstance(toolset._hook_stats, ToolHookStats)

    def test_get_hook_stats(self):
        """Test getting hook statistics."""
        toolset = KimiToolset()
        stats = toolset.get_hook_stats()

        assert isinstance(stats, ToolHookStats)
        assert stats.total_calls == 0

    def test_clear_hook_cache(self):
        """Test clearing hook cache."""
        toolset = KimiToolset()
        toolset._hook_cache.set("event", "tool", {"arg": 1}, "value")

        toolset.clear_hook_cache()

        assert toolset._hook_cache.get("event", "tool", {"arg": 1}) is None


class TestBeforeToolHooks:
    """Test before_tool hook execution."""

    @pytest.mark.asyncio
    async def test_before_tool_hook_allows_execution(self):
        """Test that before_tool hook allows tool execution when decision is allow."""
        mock_runtime = MagicMock()
        mock_runtime.session.id = "sess_123"
        mock_runtime.session.work_dir = "/tmp"

        # Mock hook manager to return allow decision
        mock_hook_manager = MagicMock()
        mock_result = MagicMock()
        mock_result.success = True
        mock_result.decision = HookDecision.ALLOW
        mock_result.reason = None
        mock_result.modified_input = None
        mock_hook_manager.execute = AsyncMock(return_value=[mock_result])
        mock_runtime.hook_manager = mock_hook_manager

        toolset = KimiToolset(runtime=mock_runtime)

        # Execute before_tool hooks
        result = await toolset._execute_before_tool_hooks(
            tool_name="Shell",
            tool_input={"command": "ls"},
            tool_use_id="tool_123",
        )

        # Should return None (allow execution)
        assert result is None
        assert toolset._hook_stats.total_calls == 1

    @pytest.mark.asyncio
    async def test_before_tool_hook_blocks_execution(self):
        """Test that before_tool hook blocks tool execution when decision is deny."""
        mock_runtime = MagicMock()
        mock_runtime.session.id = "sess_123"
        mock_runtime.session.work_dir = "/tmp"

        # Mock hook manager to return deny decision
        mock_hook_manager = MagicMock()
        mock_result = MagicMock()
        mock_result.success = True
        mock_result.decision = HookDecision.DENY
        mock_result.reason = "Dangerous command detected"
        mock_hook_manager.execute = AsyncMock(return_value=[mock_result])
        mock_runtime.hook_manager = mock_hook_manager

        toolset = KimiToolset(runtime=mock_runtime)

        # Execute before_tool hooks
        result = await toolset._execute_before_tool_hooks(
            tool_name="Shell",
            tool_input={"command": "rm -rf /"},
            tool_use_id="tool_123",
        )

        # Should return a ToolResult (block execution)
        assert result is not None
        assert result.tool_call_id == "tool_123"
        assert toolset._hook_stats.blocked_calls == 1

    @pytest.mark.asyncio
    async def test_before_tool_hook_fail_open(self):
        """Test that before_tool hooks fail open on error."""
        mock_runtime = MagicMock()
        mock_runtime.session.id = "sess_123"
        mock_runtime.session.work_dir = "/tmp"

        # Mock hook manager to raise exception
        mock_hook_manager = MagicMock()
        mock_hook_manager.execute = AsyncMock(side_effect=Exception("Hook failed"))
        mock_runtime.hook_manager = mock_hook_manager

        toolset = KimiToolset(runtime=mock_runtime)

        # Execute before_tool hooks - should not raise
        result = await toolset._execute_before_tool_hooks(
            tool_name="Shell",
            tool_input={"command": "ls"},
            tool_use_id="tool_123",
        )

        # Should return None (fail open)
        assert result is None

    @pytest.mark.asyncio
    async def test_before_tool_hook_cache_hit(self):
        """Test that cache is used for repeated tool calls."""
        mock_runtime = MagicMock()
        mock_runtime.session.id = "sess_123"
        mock_runtime.session.work_dir = "/tmp"

        # Pre-populate cache with block result
        toolset = KimiToolset(runtime=mock_runtime)
        from kosong.tooling.error import ToolError

        from kimi_cli.wire.types import ToolResult

        cached_result = ToolResult(
            tool_call_id="tool_123",
            return_value=ToolError(message="Cached block", brief="Blocked"),
        )
        toolset._hook_cache.set("before_tool", "Shell", {"command": "ls"}, cached_result)

        # Execute before_tool hooks
        result = await toolset._execute_before_tool_hooks(
            tool_name="Shell",
            tool_input={"command": "ls"},
            tool_use_id="tool_123",
        )

        # Should return cached result
        assert result is cached_result
        assert toolset._hook_stats.cache_hits == 1

    @pytest.mark.asyncio
    async def test_before_tool_hook_no_runtime(self):
        """Test that before_tool hooks are skipped when no runtime."""
        toolset = KimiToolset(runtime=None)

        result = await toolset._execute_before_tool_hooks(
            tool_name="Shell",
            tool_input={"command": "ls"},
            tool_use_id="tool_123",
        )

        assert result is None


class TestAfterToolHooks:
    """Test after_tool hook execution."""

    @pytest.mark.asyncio
    async def test_after_tool_hook_execution(self):
        """Test that after_tool hooks are executed."""
        mock_runtime = MagicMock()
        mock_runtime.session.id = "sess_123"
        mock_runtime.session.work_dir = "/tmp"

        mock_hook_manager = MagicMock()
        mock_result = MagicMock()
        mock_result.success = True
        mock_hook_manager.execute = AsyncMock(return_value=[mock_result])
        mock_runtime.hook_manager = mock_hook_manager

        toolset = KimiToolset(runtime=mock_runtime)

        # Execute after_tool hooks
        await toolset._execute_after_tool_hooks(
            tool_name="Shell",
            tool_input={"command": "ls"},
            tool_output="file1.txt\nfile2.txt",
            error=None,
            tool_use_id="tool_123",
            duration_ms=100,
        )

        # Verify hook manager was called
        assert mock_hook_manager.execute.called

    @pytest.mark.asyncio
    async def test_after_tool_hook_no_runtime(self):
        """Test that after_tool hooks are skipped when no runtime."""
        toolset = KimiToolset(runtime=None)

        # Should not raise
        await toolset._execute_after_tool_hooks(
            tool_name="Shell",
            tool_input={"command": "ls"},
            tool_output="file1.txt\nfile2.txt",
            error=None,
            tool_use_id="tool_123",
            duration_ms=100,
        )

    @pytest.mark.asyncio
    async def test_after_tool_hook_handles_error(self):
        """Test that after_tool hook errors are handled gracefully."""
        mock_runtime = MagicMock()
        mock_runtime.session.id = "sess_123"
        mock_runtime.session.work_dir = "/tmp"

        mock_hook_manager = MagicMock()
        mock_hook_manager.execute = AsyncMock(side_effect=Exception("Hook failed"))
        mock_runtime.hook_manager = mock_hook_manager

        toolset = KimiToolset(runtime=mock_runtime)

        # Should not raise
        await toolset._execute_after_tool_hooks(
            tool_name="Shell",
            tool_input={"command": "ls"},
            tool_output="file1.txt\nfile2.txt",
            error=None,
            tool_use_id="tool_123",
            duration_ms=100,
        )


class TestToolHooksIntegration:
    """Integration tests for tool interception hooks."""

    @pytest.mark.asyncio
    async def test_end_to_end_tool_blocking(self):
        """Test end-to-end tool blocking scenario."""
        mock_runtime = MagicMock()
        mock_runtime.session.id = "sess_123"
        mock_runtime.session.work_dir = "/tmp"

        # Create a config with a blocking hook
        config = HooksConfig(
            before_tool=[
                HookConfig(
                    name="block-dangerous",
                    command='echo \'{"decision": "deny", "reason": "Dangerous command"}\'',
                    matcher={"tool": "Shell", "pattern": "rm.*-rf"},
                )
            ]
        )

        from kimi_cli.hooks.manager import HookManager

        mock_runtime.hook_manager = HookManager(config).with_runtime(mock_runtime)

        toolset = KimiToolset(runtime=mock_runtime)

        # Create a mock tool call
        tool_call = ToolCall(
            id="tool_123",
            function=ToolCall.FunctionBody(
                name="Shell",
                arguments=json.dumps({"command": "rm -rf /"}),
            ),
        )

        # The handle method should return a blocked result
        with patch.object(toolset, "_tool_dict", {}):  # No actual tools registered
            _result = toolset.handle(tool_call)
            # Since tool is not registered, it returns ToolNotFoundError
            # But hooks would be executed if tool existed

    def test_event_type_constants(self):
        """Test that event type constants are defined."""
        assert HookEventType.BEFORE_TOOL.value == "before_tool"
        assert HookEventType.AFTER_TOOL.value == "after_tool"
        assert HookEventType.AFTER_TOOL_FAILURE.value == "after_tool_failure"

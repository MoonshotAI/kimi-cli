from __future__ import annotations

import asyncio
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from kimi_cli.hooks.config import HookConfig, HookEventType, HooksConfig
from kimi_cli.hooks.manager import CommandResult, HookManager
from kimi_cli.hooks.models import HookDecision, HookEvent, HookResult


@pytest.fixture
def sample_config():
    return HooksConfig(
        before_tool=[
            HookConfig(
                name="test-hook",
                command='echo \'{ "decision": "allow" }\'',
                timeout=5000,
            ),
        ]
    )


@pytest.fixture
def sample_event():
    return HookEvent(
        event_type="before_tool",
        timestamp=datetime.now(),
        session_id="sess_123",
        work_dir="/home/user/project",
        context={"tool_name": "Shell"},
    )


class TestHookManager:
    def test_init_empty(self):
        manager = HookManager()
        assert manager._config == HooksConfig()
        assert manager._runtime is None

    def test_init_with_config(self, sample_config):
        manager = HookManager(config=sample_config)
        assert manager._config == sample_config

    def test_with_runtime(self):
        manager = HookManager()
        mock_runtime = MagicMock()
        mock_runtime.session.work_dir = "/tmp/test"
        mock_runtime.session.session_id = "sess_123"

        new_manager = manager.with_runtime(mock_runtime)
        assert new_manager._runtime == mock_runtime
        assert new_manager._env_file is not None

    def test_get_hooks_for_event(self, sample_config):
        manager = HookManager(config=sample_config)
        hooks = manager._get_hooks_for_event(HookEventType.BEFORE_TOOL)
        assert len(hooks) == 1
        assert hooks[0].name == "test-hook"

    def test_get_hooks_for_empty_event(self, sample_config):
        manager = HookManager(config=sample_config)
        hooks = manager._get_hooks_for_event(HookEventType.AFTER_TOOL)
        assert hooks == []


class TestHookManagerExecute:
    async def test_execute_no_hooks(self, sample_event):
        manager = HookManager(config=HooksConfig())
        results = await manager.execute(HookEventType.BEFORE_TOOL, sample_event)
        assert results == []

    async def test_execute_with_matcher_filter(self, sample_event):
        config = HooksConfig(
            before_tool=[
                HookConfig(
                    name="shell-hook",
                    command='echo \'{ "decision": "allow" }\'',
                    matcher={"tool": "Shell"},  # Only matches Shell
                ),
                HookConfig(
                    name="file-hook",
                    command='echo \'{ "decision": "allow" }\'',
                    matcher={"tool": "WriteFile"},  # Only matches WriteFile
                ),
            ]
        )
        manager = HookManager(config=config)

        # Should only match shell-hook
        with patch.object(manager, "_execute_command_hook", new_callable=AsyncMock) as mock_exec:
            mock_exec.return_value = HookResult(
                success=True,
                hook_name="test",
                hook_type="command",
                duration_ms=0,
            )
            await manager.execute(
                HookEventType.BEFORE_TOOL,
                sample_event,
                tool_name="Shell",
                tool_input={"command": "ls"},
            )
            assert mock_exec.call_count == 1

    async def test_execute_parallel(self, sample_event):
        config = HooksConfig(
            before_tool=[
                HookConfig(name="hook1", command="echo 1"),
                HookConfig(name="hook2", command="echo 2"),
                HookConfig(name="hook3", command="echo 3"),
            ]
        )
        manager = HookManager(config=config)

        with patch.object(manager, "_execute_command_hook", new_callable=AsyncMock) as mock_exec:
            mock_exec.return_value = HookResult(
                success=True,
                hook_name="test",
                hook_type="command",
                duration_ms=0,
            )
            results = await manager.execute(HookEventType.BEFORE_TOOL, sample_event)
            assert len(results) == 3
            assert mock_exec.call_count == 3


class TestHookManagerParseResult:
    def test_parse_exit_code_0_json(self):
        manager = HookManager()
        hook = HookConfig(command="echo test")
        result = manager._parse_command_result(
            hook,
            CommandResult(exit_code=0, stdout='{"decision": "deny", "reason": "test"}', stderr=""),
        )
        assert result.decision == HookDecision.DENY
        assert result.reason == "test"
        assert result.success is True

    def test_parse_exit_code_0_non_json(self):
        manager = HookManager()
        hook = HookConfig(command="echo test")
        result = manager._parse_command_result(
            hook,
            CommandResult(exit_code=0, stdout="Plain text output", stderr=""),
        )
        assert result.decision == HookDecision.ALLOW
        assert result.additional_context == "Plain text output"

    def test_parse_exit_code_2(self):
        manager = HookManager()
        hook = HookConfig(command="echo test")
        result = manager._parse_command_result(
            hook,
            CommandResult(exit_code=2, stdout="", stderr="Blocking error"),
        )
        assert result.decision == HookDecision.DENY
        assert result.reason == "Blocking error"
        assert result.exit_code == 2

    def test_parse_other_exit_code(self):
        manager = HookManager()
        hook = HookConfig(command="echo test")
        result = manager._parse_command_result(
            hook,
            CommandResult(exit_code=1, stdout="", stderr="Some error"),
        )
        assert result.decision == HookDecision.ALLOW  # Fail open
        assert result.success is False
        assert "1" in result.reason

    def test_error_to_result(self):
        manager = HookManager()
        error = ValueError("Test error")
        result = manager._error_to_result(error)
        assert result.success is False
        assert result.hook_name == "unknown"
        assert result.reason == "Test error"
        assert result.decision == HookDecision.ALLOW


class TestHookManagerExecuteCommand:
    async def test_execute_command_basic(self, sample_event):
        manager = HookManager()
        hook = HookConfig(command="cat")  # Echo stdin back

        with patch("asyncio.create_subprocess_shell") as mock_create:
            mock_proc = AsyncMock()
            mock_proc.returncode = 0
            mock_proc.communicate.return_value = (b'{"decision": "allow"}', b"")
            mock_create.return_value = mock_proc

            result = await manager._execute_command_hook(hook, sample_event)

            assert result.success is True
            assert result.decision == HookDecision.ALLOW

    async def test_execute_command_with_runtime(self, sample_event):
        mock_runtime = MagicMock()
        mock_runtime.session.session_id = "sess_123"
        mock_runtime.session.work_dir = "/tmp/test"

        manager = HookManager().with_runtime(mock_runtime)
        hook = HookConfig(command="echo test")

        with patch("asyncio.create_subprocess_shell") as mock_create:
            mock_proc = AsyncMock()
            mock_proc.returncode = 0
            mock_proc.communicate.return_value = (b"{}", b"")
            mock_create.return_value = mock_proc

            await manager._execute_command_hook(hook, sample_event)

            # Check that subprocess was called with env containing KIMI_* vars
            call_kwargs = mock_create.call_args[1]
            assert "env" in call_kwargs
            assert call_kwargs["env"]["KIMI_SESSION_ID"] == "sess_123"
            assert call_kwargs["env"]["KIMI_WORK_DIR"] == "/tmp/test"

    async def test_execute_command_timeout(self, sample_event):
        manager = HookManager()
        hook = HookConfig(command="sleep 10", timeout=100)  # 100ms timeout

        with patch("asyncio.create_subprocess_shell") as mock_create:
            mock_proc = AsyncMock()
            # kill() is synchronous in real Popen, use Mock not AsyncMock
            mock_proc.kill = Mock()
            # Simulate timeout by raising asyncio.TimeoutError

            async def slow_communicate(*args, **kwargs):
                await asyncio.sleep(1)  # This won't complete
                return b"", b""

            mock_proc.communicate.side_effect = slow_communicate
            mock_create.return_value = mock_proc

            with pytest.raises(asyncio.TimeoutError):
                await manager._execute_command_hook(hook, sample_event)

"""Tests for AgentHooks system.

This module contains all tests for the hooks functionality including:
- Parser tests (metadata, matcher, hook parsing)
- Discovery tests (path resolution, hook discovery)
- Executor tests (result parsing, hook execution)
- Manager tests (debugger, hook management)
- Integration tests (end-to-end scenarios)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kimi_cli.hooks import HookDiscovery, HookManager
from kimi_cli.hooks.discovery import DiscoveryPaths
from kimi_cli.hooks.executor import (
    CommandResult,
    ExecutionResult,
    HookExecutor,
    HooksExecutionResult,
)
from kimi_cli.hooks.manager import HookDebugger
from kimi_cli.hooks.parser import HookMetadata, HookParser, Matcher, ParsedHook


# =============================================================================
# Parser Tests
# =============================================================================


class TestHookMetadata:
    """Test HookMetadata model."""

    def test_basic_creation(self):
        """Test basic creation of HookMetadata."""
        metadata = HookMetadata(
            name="test-hook",
            trigger="pre-tool-call",
        )
        assert metadata.name == "test-hook"
        assert metadata.trigger == "pre-tool-call"
        assert metadata.description == ""
        assert metadata.matcher is None
        assert metadata.timeout == 30000
        assert metadata.async_ is False
        assert metadata.priority == 100

    def test_full_creation(self):
        """Test creation with all fields."""
        metadata = HookMetadata(
            name="block-dangerous",
            trigger="pre-tool-call",
            description="Block dangerous commands",
            matcher={"tool": "Shell", "pattern": "rm -rf"},
            timeout=5000,
            async_=False,
            priority=999,
        )
        assert metadata.name == "block-dangerous"
        assert metadata.trigger == "pre-tool-call"
        assert metadata.description == "Block dangerous commands"
        assert metadata.matcher == {"tool": "Shell", "pattern": "rm -rf"}
        assert metadata.timeout == 5000
        assert metadata.async_ is False
        assert metadata.priority == 999

    def test_from_dict(self):
        """Test creating from dictionary with legacy trigger name normalization."""
        data = {
            "name": "test-hook",
            "trigger": "pre-session",  # Legacy name
            "description": "Test hook",
            "async": True,
            "priority": 50,
        }
        metadata = HookMetadata.from_dict(data)
        assert metadata.name == "test-hook"
        assert metadata.trigger == "pre-session"  # Normalized to canonical name
        assert metadata.description == "Test hook"
        assert metadata.async_ is True
        assert metadata.priority == 50

    def test_from_dict_with_canonical_trigger(self):
        """Test creating from dictionary with canonical trigger name."""
        data = {
            "name": "test-hook",
            "trigger": "pre-tool-call",  # Canonical name
            "description": "Test hook",
        }
        metadata = HookMetadata.from_dict(data)
        assert metadata.trigger == "pre-tool-call"  # Stays as-is

    def test_from_dict_with_async_alias(self):
        """Test that both 'async' and 'async_' work."""
        data1 = {"name": "test", "trigger": "test", "async": True}
        data2 = {"name": "test", "trigger": "test", "async_": True}

        metadata1 = HookMetadata.from_dict(data1)
        metadata2 = HookMetadata.from_dict(data2)

        assert metadata1.async_ is True
        assert metadata2.async_ is True


class TestMatcher:
    """Test Matcher functionality."""

    def test_empty_matcher_matches_all(self):
        """Test that empty matcher matches everything."""
        matcher = Matcher()
        assert matcher.matches("Shell", {"command": "ls"}) is True
        assert matcher.matches(None, None) is True

    def test_tool_pattern_matching(self):
        """Test tool name pattern matching."""
        matcher = Matcher(tool="Shell|WriteFile")
        assert matcher.matches("Shell", {}) is True
        assert matcher.matches("WriteFile", {}) is True
        assert matcher.matches("ReadFile", {}) is False

    def test_arg_pattern_matching(self):
        """Test argument pattern matching."""
        matcher = Matcher(pattern="rm -rf|dangerous")
        assert matcher.matches("Shell", {"command": "rm -rf /"}) is True
        assert matcher.matches("Shell", {"command": "echo hello"}) is False

    def test_combined_matching(self):
        """Test combined tool and pattern matching."""
        matcher = Matcher(tool="Shell", pattern="rm -rf")
        assert matcher.matches("Shell", {"command": "rm -rf /"}) is True
        assert matcher.matches("WriteFile", {"command": "rm -rf /"}) is False
        assert matcher.matches("Shell", {"command": "ls"}) is False


class TestHookParser:
    """Test HookParser functionality."""

    def test_parse_simple_hook(self):
        """Test parsing a simple HOOK.md content."""
        content = """---
name: test-hook
trigger: pre-tool-call
description: A test hook
---

# Test Hook

This is a test hook.
"""
        hook = HookParser.parse_content(content, "test-hook")

        assert hook.name == "test-hook"
        assert hook.trigger == "pre-tool-call"
        assert hook.metadata.description == "A test hook"
        assert "# Test Hook" in hook.content

    def test_parse_with_matcher(self):
        """Test parsing hook with matcher."""
        content = """---
name: block-dangerous
trigger: pre-tool-call
matcher:
  tool: Shell
  pattern: "rm -rf|mkfs"
timeout: 5000
priority: 999
---

Block dangerous commands.
"""
        hook = HookParser.parse_content(content)

        assert hook.metadata.matcher == {"tool": "Shell", "pattern": "rm -rf|mkfs"}
        assert hook.metadata.timeout == 5000
        assert hook.metadata.priority == 999

    def test_parse_async_hook(self):
        """Test parsing async hook."""
        content = """---
name: async-hook
trigger: post-tool-call
async: true
---

Async hook.
"""
        hook = HookParser.parse_content(content)

        assert hook.metadata.async_ is True

    def test_parse_missing_frontmatter(self):
        """Test that missing frontmatter raises error."""
        content = "# Just markdown\n\nNo frontmatter here."

        with pytest.raises(ValueError, match="No YAML frontmatter"):
            HookParser.parse_content(content)


class TestParsedHook:
    """Test ParsedHook functionality."""

    def test_find_entry_point_priority(self, tmp_path):
        """Test entry point discovery priority."""
        hook_dir = tmp_path / "test-hook"
        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir(parents=True)

        # Create all three entry points
        (scripts_dir / "run").touch()
        (scripts_dir / "run.sh").touch()
        (scripts_dir / "run.py").touch()

        hook = ParsedHook(
            path=hook_dir,
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )

        # Should return 'run' first (highest priority)
        entry = hook.find_entry_point()
        assert entry == scripts_dir / "run"

    def test_find_entry_point_single(self, tmp_path):
        """Test finding single entry point."""
        hook_dir = tmp_path / "test-hook"
        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir(parents=True)

        (scripts_dir / "run.sh").touch()

        hook = ParsedHook(
            path=hook_dir,
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )

        entry = hook.find_entry_point()
        assert entry == scripts_dir / "run.sh"

    def test_find_entry_point_none(self, tmp_path):
        """Test when no entry point exists."""
        hook_dir = tmp_path / "test-hook"
        hook_dir.mkdir()

        hook = ParsedHook(
            path=hook_dir,
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )

        assert hook.find_entry_point() is None


# =============================================================================
# Discovery Tests
# =============================================================================


class TestDiscoveryPaths:
    """Test DiscoveryPaths functionality."""

    def test_from_work_dir(self, tmp_path, monkeypatch):
        """Test creating discovery paths from working directory."""
        # Set up fake home
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)

        work_dir = tmp_path / "project"
        work_dir.mkdir()

        paths = DiscoveryPaths.from_work_dir(work_dir)

        assert paths.user_hooks == tmp_path / ".config" / "agents" / "hooks"
        assert paths.project_hooks is None  # No .agents/hooks directory

    def test_from_work_dir_with_project_hooks(self, tmp_path, monkeypatch):
        """Test when project hooks directory exists."""
        monkeypatch.setenv("HOME", str(tmp_path))

        work_dir = tmp_path / "project"
        project_hooks = work_dir / ".agents" / "hooks"
        project_hooks.mkdir(parents=True)

        paths = DiscoveryPaths.from_work_dir(work_dir)

        assert paths.project_hooks == project_hooks

    def test_xdg_config_home(self, tmp_path, monkeypatch):
        """Test XDG_CONFIG_HOME environment variable."""
        xdg_home = tmp_path / "xdg_config"
        monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg_home))

        work_dir = tmp_path / "project"
        work_dir.mkdir()

        paths = DiscoveryPaths.from_work_dir(work_dir)

        assert paths.user_hooks == xdg_home / "agents" / "hooks"


class TestHookDiscovery:
    """Test HookDiscovery functionality."""

    def test_discover_no_hooks(self, tmp_path, monkeypatch):
        """Test discovery with no hooks."""
        monkeypatch.setenv("HOME", str(tmp_path))

        discovery = HookDiscovery(tmp_path)
        hooks = discovery.discover(use_cache=False)

        assert hooks == []

    def test_discover_user_hooks(self, tmp_path, monkeypatch):
        """Test discovering user-level hooks."""
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)

        # Create user hooks directory
        hooks_dir = tmp_path / ".config" / "agents" / "hooks"
        hook_dir = hooks_dir / "test-hook"
        hook_dir.mkdir(parents=True)

        (hook_dir / "HOOK.md").write_text("""---
name: test-hook
trigger: pre-tool-call
---

Test hook.
""")

        discovery = HookDiscovery(tmp_path)
        hooks = discovery.discover(use_cache=False)

        assert len(hooks) == 1
        assert hooks[0].name == "test-hook"

    def test_discover_project_hooks_override(self, tmp_path, monkeypatch):
        """Test that project hooks override user hooks."""
        monkeypatch.setenv("HOME", str(tmp_path))

        work_dir = tmp_path / "project"
        work_dir.mkdir()

        # Create user hook
        user_hooks = tmp_path / ".config" / "agents" / "hooks"
        user_hook = user_hooks / "shared-hook"
        user_hook.mkdir(parents=True)
        (user_hook / "HOOK.md").write_text("""---
name: shared-hook
trigger: pre-tool-call
description: User version
---
""")

        # Create project hook with same name
        project_hooks = work_dir / ".agents" / "hooks"
        project_hook = project_hooks / "shared-hook"
        project_hook.mkdir(parents=True)
        (project_hook / "HOOK.md").write_text("""---
name: shared-hook
trigger: pre-tool-call
description: Project version
---
""")

        discovery = HookDiscovery(work_dir)
        hooks = discovery.discover(use_cache=False)

        assert len(hooks) == 1
        assert hooks[0].metadata.description == "Project version"

    def test_discover_by_trigger(self, tmp_path, monkeypatch):
        """Test discovering hooks filtered by trigger."""
        monkeypatch.setenv("HOME", str(tmp_path))

        hooks_dir = tmp_path / ".config" / "agents" / "hooks"

        # Create before_tool hook
        hook1 = hooks_dir / "hook1"
        hook1.mkdir(parents=True)
        (hook1 / "HOOK.md").write_text("""---
name: hook1
trigger: pre-tool-call
---
""")

        # Create session_start hook
        hook2 = hooks_dir / "hook2"
        hook2.mkdir(parents=True)
        (hook2 / "HOOK.md").write_text("""---
name: hook2
trigger: pre-session
---
""")

        discovery = HookDiscovery(tmp_path)
        before_tool_hooks = discovery.discover_by_trigger("pre-tool-call")

        assert len(before_tool_hooks) == 1
        assert before_tool_hooks[0].name == "hook1"

    def test_priority_sorting(self, tmp_path, monkeypatch):
        """Test that hooks are sorted by priority."""
        monkeypatch.setenv("HOME", str(tmp_path))

        hooks_dir = tmp_path / ".config" / "agents" / "hooks"

        # Create hooks with different priorities
        for name, priority in [("low", 10), ("high", 999), ("medium", 100)]:
            hook_dir = hooks_dir / name
            hook_dir.mkdir(parents=True)
            (hook_dir / "HOOK.md").write_text(f"""---
name: {name}
trigger: pre-tool-call
priority: {priority}
---
""")

        discovery = HookDiscovery(tmp_path)
        hooks = discovery.discover(use_cache=False)

        # Should be sorted by priority descending
        priorities = [h.metadata.priority for h in hooks]
        assert priorities == [999, 100, 10]

    def test_cache_invalidation(self, tmp_path, monkeypatch):
        """Test cache invalidation."""
        monkeypatch.setenv("HOME", str(tmp_path))

        discovery = HookDiscovery(tmp_path)

        # First discovery
        hooks1 = discovery.discover(use_cache=True)

        # Invalidate and rediscover
        discovery.invalidate_cache()
        hooks2 = discovery.discover(use_cache=True)

        # Should work even with empty hooks
        assert hooks1 == hooks2

    def test_get_hook_by_name(self, tmp_path, monkeypatch):
        """Test getting a specific hook by name."""
        monkeypatch.setenv("HOME", str(tmp_path))

        hooks_dir = tmp_path / ".config" / "agents" / "hooks"
        hook_dir = hooks_dir / "specific-hook"
        hook_dir.mkdir(parents=True)
        (hook_dir / "HOOK.md").write_text("""---
name: specific-hook
trigger: pre-tool-call
---
""")

        discovery = HookDiscovery(tmp_path)
        hook = discovery.get_hook_by_name("specific-hook")

        assert hook is not None
        assert hook.name == "specific-hook"

    def test_get_hook_by_name_not_found(self, tmp_path, monkeypatch):
        """Test getting a non-existent hook."""
        monkeypatch.setenv("HOME", str(tmp_path))

        discovery = HookDiscovery(tmp_path)
        hook = discovery.get_hook_by_name("non-existent")

        assert hook is None

    def test_list_all_triggers(self, tmp_path, monkeypatch):
        """Test listing all unique triggers."""
        monkeypatch.setenv("HOME", str(tmp_path))

        hooks_dir = tmp_path / ".config" / "agents" / "hooks"

        triggers = ["pre-tool-call", "post-tool-call", "pre-session"]
        for i, trigger in enumerate(triggers):
            hook_dir = hooks_dir / f"hook{i}"
            hook_dir.mkdir(parents=True)
            (hook_dir / "HOOK.md").write_text(f"""---
name: hook{i}
trigger: {trigger}
---
""")

        discovery = HookDiscovery(tmp_path)
        found_triggers = discovery.list_all_triggers()

        assert found_triggers == set(triggers)

    def test_invalid_hook_ignored(self, tmp_path, monkeypatch, caplog):
        """Test that invalid hooks are skipped with warning."""
        monkeypatch.setenv("HOME", str(tmp_path))

        # Set logging level to capture warnings
        caplog.set_level(logging.WARNING)

        hooks_dir = tmp_path / ".config" / "agents" / "hooks"

        # Create valid hook
        valid_hook = hooks_dir / "valid"
        valid_hook.mkdir(parents=True)
        (valid_hook / "HOOK.md").write_text("""---
name: valid
trigger: pre-tool-call
---
""")

        # Create invalid hook (no frontmatter)
        invalid_hook = hooks_dir / "invalid"
        invalid_hook.mkdir(parents=True)
        (invalid_hook / "HOOK.md").write_text("Just markdown, no frontmatter.")

        discovery = HookDiscovery(tmp_path)
        hooks = discovery.discover(use_cache=False)

        # Should only find the valid hook
        assert len(hooks) == 1
        assert hooks[0].name == "valid"


# =============================================================================
# Executor Tests
# =============================================================================


class TestExecutionResult:
    """Test ExecutionResult functionality."""

    def test_basic_creation(self):
        """Test basic creation of ExecutionResult."""
        result = ExecutionResult(
            success=True,
            hook_name="test-hook",
            duration_ms=100,
            exit_code=0,
            stdout="",
            stderr="",
        )
        assert result.success is True
        assert result.hook_name == "test-hook"
        assert result.should_block is False

    def test_block_result(self):
        """Test result that should block."""
        result = ExecutionResult(
            success=True,
            hook_name="blocker",
            duration_ms=50,
            exit_code=2,
            stdout="",
            stderr="Dangerous command",
            decision="deny",
            reason="Dangerous command",
            should_block=True,
        )
        assert result.should_block is True
        assert result.decision == "deny"


class TestHookExecutorResultParsing:
    """Test HookExecutor result parsing."""

    def test_parse_exit_code_0_allow(self):
        """Test parsing successful execution with allow decision."""
        executor = HookExecutor()
        hook = ParsedHook(
            path=Path("/tmp/test"),
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )
        result = CommandResult(
            exit_code=0,
            stdout='{"decision": "allow", "additional_context": "All good"}',
            stderr="",
        )

        parsed = executor._parse_result(hook, result, 100)

        assert parsed.success is True
        assert parsed.decision == "allow"
        assert parsed.additional_context == "All good"
        assert parsed.should_block is False

    def test_parse_exit_code_0_deny(self):
        """Test parsing successful execution with deny decision."""
        executor = HookExecutor()
        hook = ParsedHook(
            path=Path("/tmp/test"),
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )
        result = CommandResult(
            exit_code=0,
            stdout='{"decision": "deny", "reason": "Not allowed"}',
            stderr="",
        )

        parsed = executor._parse_result(hook, result, 100)

        assert parsed.decision == "deny"
        assert parsed.should_block is True
        assert parsed.reason == "Not allowed"

    def test_parse_exit_code_2_block(self):
        """Test parsing exit code 2 (blocking)."""
        executor = HookExecutor()
        hook = ParsedHook(
            path=Path("/tmp/test"),
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )
        result = CommandResult(
            exit_code=2,
            stdout="",
            stderr="Critical error",
        )

        parsed = executor._parse_result(hook, result, 100)

        assert parsed.success is True  # Execution succeeded in blocking
        assert parsed.decision == "deny"
        assert parsed.should_block is True
        assert parsed.reason == "Critical error"

    def test_parse_nonzero_exit_warning(self):
        """Test parsing non-zero exit (non-blocking error)."""
        executor = HookExecutor()
        hook = ParsedHook(
            path=Path("/tmp/test"),
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )
        result = CommandResult(
            exit_code=1,
            stdout="",
            stderr="Something went wrong",
        )

        parsed = executor._parse_result(hook, result, 100)

        assert parsed.success is False
        assert parsed.decision == "allow"  # Fail open
        assert parsed.should_block is False

    def test_parse_invalid_json_stdout(self):
        """Test parsing when stdout is not valid JSON."""
        executor = HookExecutor()
        hook = ParsedHook(
            path=Path("/tmp/test"),
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )
        result = CommandResult(
            exit_code=0,
            stdout="Plain text output",
            stderr="",
        )

        parsed = executor._parse_result(hook, result, 100)

        assert parsed.success is True
        assert parsed.additional_context == "Plain text output"

    def test_parse_invalid_decision(self):
        """Test parsing with invalid decision value."""
        executor = HookExecutor()
        hook = ParsedHook(
            path=Path("/tmp/test"),
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )
        result = CommandResult(
            exit_code=0,
            stdout='{"decision": "invalid"}',
            stderr="",
        )

        parsed = executor._parse_result(hook, result, 100)

        assert parsed.decision == "allow"  # Defaults to allow

    def test_parse_modified_input(self):
        """Test parsing with modified input."""
        executor = HookExecutor()
        hook = ParsedHook(
            path=Path("/tmp/test"),
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )
        result = CommandResult(
            exit_code=0,
            stdout='{"decision": "allow", "modified_input": {"command": "modified"}}',
            stderr="",
        )

        parsed = executor._parse_result(hook, result, 100)

        assert parsed.modified_input == {"command": "modified"}


class TestHookExecutorIntegration:
    """Integration tests for HookExecutor."""

    @pytest.mark.asyncio
    async def test_execute_no_entry_point(self):
        """Test execution when no entry point exists."""
        executor = HookExecutor()
        hook = ParsedHook(
            path=Path("/nonexistent"),
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )

        result = await executor.execute(hook, {"event_type": "test"})

        assert result.success is False
        assert "No entry point found" in result.stderr

    @pytest.mark.asyncio
    async def test_execute_success(self, tmp_path):
        """Test successful hook execution."""
        executor = HookExecutor()

        # Create hook directory with script
        hook_dir = tmp_path / "test-hook"
        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir(parents=True)

        script = scripts_dir / "run.sh"
        script.write_text("#!/bin/bash\necho '{\"decision\": \"allow\"}'")
        os.chmod(script, 0o755)

        hook = ParsedHook(
            path=hook_dir,
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )

        result = await executor.execute(hook, {"event_type": "test"})

        assert result.success is True
        assert result.decision == "allow"

    @pytest.mark.asyncio
    async def test_execute_with_event_data(self, tmp_path):
        """Test that event data is passed to hook."""
        executor = HookExecutor()

        hook_dir = tmp_path / "test-hook"
        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir(parents=True)

        script = scripts_dir / "run.sh"
        script.write_text("#!/bin/bash\ncat | grep -q 'event_type' && echo '{\"decision\": \"allow\"}'")
        os.chmod(script, 0o755)

        hook = ParsedHook(
            path=hook_dir,
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )

        result = await executor.execute(hook, {"event_type": "pre-tool-call", "tool_name": "Shell"})

        assert result.success is True

    @pytest.mark.asyncio
    async def test_execute_timeout(self, tmp_path):
        """Test hook timeout."""
        executor = HookExecutor()

        hook_dir = tmp_path / "slow-hook"
        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir(parents=True)

        script = scripts_dir / "run.sh"
        script.write_text("#!/bin/bash\nsleep 10")  # Will timeout
        os.chmod(script, 0o755)

        hook = ParsedHook(
            path=hook_dir,
            metadata=HookMetadata(name="slow", trigger="test", timeout=100),  # 100ms timeout
            content="",
        )

        result = await executor.execute(hook, {"event_type": "test"})

        assert result.success is False
        assert "timeout" in result.reason.lower()

    @pytest.mark.asyncio
    async def test_execute_with_runtime(self, tmp_path):
        """Test execution with runtime (sets env vars)."""
        mock_runtime = MagicMock()
        mock_runtime.session.id = "test-session-123"
        mock_runtime.session.work_dir = "/tmp/test"

        executor = HookExecutor(runtime=mock_runtime)

        hook_dir = tmp_path / "test-hook"
        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir(parents=True)

        script = scripts_dir / "run.sh"
        script.write_text(
            '#!/bin/bash\n'
            'if [ -n "$KIMI_SESSION_ID" ] && [ -n "$KIMI_WORK_DIR" ]; then\n'
            '  echo \'{"decision": "allow"}\'\n'
            'else\n'
            '  echo \'{"decision": "deny"}\'\n'
            'fi'
        )
        os.chmod(script, 0o755)

        hook = ParsedHook(
            path=hook_dir,
            metadata=HookMetadata(name="test", trigger="test"),
            content="",
        )

        result = await executor.execute(hook, {"event_type": "test"})

        assert result.decision == "allow"


class TestHooksExecutionResult:
    """Test HooksExecutionResult functionality."""

    def test_empty_results(self):
        """Test with no results."""
        result = HooksExecutionResult(results=[])

        assert result.should_block is False
        assert result.block_reason is None
        assert result.additional_contexts == []

    def test_should_block(self):
        """Test should_block detection."""
        results = [
            ExecutionResult(
                success=True, hook_name="first", duration_ms=10,
                exit_code=0, stdout="", stderr="", decision="allow"
            ),
            ExecutionResult(
                success=True, hook_name="second", duration_ms=20,
                exit_code=2, stdout="", stderr="Blocked!", decision="deny", should_block=True,
                reason="Blocked!"
            ),
        ]

        result = HooksExecutionResult(results=results)

        assert result.should_block is True
        assert result.block_reason == "Blocked!"

    def test_additional_contexts(self):
        """Test collecting additional contexts."""
        results = [
            ExecutionResult(
                success=True, hook_name="first", duration_ms=10,
                exit_code=0, stdout="", stderr="", additional_context="Context 1"
            ),
            ExecutionResult(
                success=True, hook_name="second", duration_ms=20,
                exit_code=0, stdout="", stderr="", additional_context="Context 2"
            ),
        ]

        result = HooksExecutionResult(results=results)

        assert "Context 1" in result.additional_contexts
        assert "Context 2" in result.additional_contexts


# =============================================================================
# Manager Tests
# =============================================================================


class TestHookDebugger:
    """Test HookDebugger functionality via HookManager."""

    def test_debugger_disabled_by_default(self, tmp_path):
        """Test that debugger is disabled by default."""
        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery)
        assert manager.debugger.enabled is False

    def test_debugger_enabled_with_debug_flag(self, tmp_path):
        """Test enabling debug mode via manager."""
        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery, debug=True)
        assert manager.debugger.enabled is True

    def test_debugger_log_start_via_manager(self, tmp_path):
        """Test logging hook start via manager's debugger."""
        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery, debug=True)
        log = manager.debugger.log_start(
            event_type="pre-tool-call",
            hook_name="test-hook",
            input_context={"tool_name": "Shell"},
            is_async=False,
        )

        assert log.event_type == "pre-tool-call"
        assert log.hook_name == "test-hook"
        assert log.is_async is False
        assert len(manager.debugger.logs) == 1

    def test_debugger_log_complete_via_manager(self, tmp_path):
        """Test logging hook completion via manager's debugger."""
        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery, debug=True)
        log = manager.debugger.log_start(
            event_type="pre-tool-call",
            hook_name="test-hook",
            input_context={},
        )

        result = ExecutionResult(
            success=True,
            hook_name="test-hook",
            duration_ms=100,
            exit_code=0,
            stdout="",
            stderr="",
            decision="allow",
        )

        manager.debugger.log_complete(log, result)

        assert log.result == result
        assert log.duration_ms == 100

    def test_debugger_log_error_via_manager(self, tmp_path):
        """Test logging hook error via manager's debugger."""
        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery, debug=True)
        log = manager.debugger.log_start(
            event_type="pre-tool-call",
            hook_name="test-hook",
            input_context={},
        )

        manager.debugger.log_error(log, "Something went wrong")

        assert log.error == "Something went wrong"

    def test_debugger_get_statistics_empty(self, tmp_path):
        """Test getting statistics with no logs."""
        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery)
        stats = manager.debugger.get_statistics()

        assert stats["total_executions"] == 0

    def test_debugger_get_statistics_with_logs(self, tmp_path):
        """Test getting statistics with logs."""
        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery, debug=True)

        # Log a successful execution
        log1 = manager.debugger.log_start("pre-tool-call", "hook1", {})
        result1 = ExecutionResult(
            success=True, hook_name="hook1", duration_ms=100,
            exit_code=0, stdout="", stderr="", decision="allow"
        )
        manager.debugger.log_complete(log1, result1)

        # Log a blocked execution
        log2 = manager.debugger.log_start("pre-tool-call", "hook2", {}, is_async=True)
        result2 = ExecutionResult(
            success=True, hook_name="hook2", duration_ms=200,
            exit_code=2, stdout="", stderr="Blocked", decision="deny", should_block=True
        )
        manager.debugger.log_complete(log2, result2)

        stats = manager.debugger.get_statistics()

        assert stats["total_executions"] == 2
        assert stats["successful"] == 2
        assert stats["blocked"] == 1
        assert stats["async"] == 1


class TestHookManager:
    """Test HookManager functionality."""

    @pytest.mark.asyncio
    async def test_execute_no_matching_hooks(self, tmp_path, monkeypatch):
        """Test execution when no hooks match."""
        monkeypatch.setenv("HOME", str(tmp_path))

        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery)

        result = await manager.execute("pre-tool-call", {"event_type": "pre-tool-call"})

        assert result.should_block is False
        assert result.results == []

    @pytest.mark.asyncio
    async def test_execute_with_matching_hooks(self, tmp_path, monkeypatch):
        """Test execution with matching hooks."""
        monkeypatch.setenv("HOME", str(tmp_path))

        # Create a hook
        hooks_dir = tmp_path / ".config" / "agents" / "hooks"
        hook_dir = hooks_dir / "test-hook"
        hook_dir.mkdir(parents=True)

        (hook_dir / "HOOK.md").write_text("""---
name: test-hook
trigger: pre-tool-call
---

Test hook.
""")

        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir()
        (scripts_dir / "run.sh").write_text("#!/bin/bash\necho '{\"decision\": \"allow\"}'")
        os.chmod(scripts_dir / "run.sh", 0o755)

        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery)

        result = await manager.execute("pre-tool-call", {"event_type": "pre-tool-call"})

        assert len(result.results) == 1
        assert result.results[0].hook_name == "test-hook"
        assert result.should_block is False

    @pytest.mark.asyncio
    async def test_execute_with_matcher(self, tmp_path, monkeypatch):
        """Test execution with tool matcher."""
        monkeypatch.setenv("HOME", str(tmp_path))

        # Create a hook that only matches Shell tool
        hooks_dir = tmp_path / ".config" / "agents" / "hooks"
        hook_dir = hooks_dir / "shell-only"
        hook_dir.mkdir(parents=True)

        (hook_dir / "HOOK.md").write_text("""---
name: shell-only
trigger: pre-tool-call
matcher:
  tool: Shell
---
""")

        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir()
        (scripts_dir / "run.sh").write_text("#!/bin/bash\necho '{\"decision\": \"allow\"}'")
        os.chmod(scripts_dir / "run.sh", 0o755)

        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery)

        # Execute with matching tool
        result = await manager.execute(
            "pre-tool-call",
            {"event_type": "pre-tool-call"},
            tool_name="Shell",
            tool_input={"command": "ls"}
        )

        assert len(result.results) == 1

        # Execute with non-matching tool
        result = await manager.execute(
            "pre-tool-call",
            {"event_type": "pre-tool-call"},
            tool_name="WriteFile",
            tool_input={"path": "/tmp/test"}
        )

        assert len(result.results) == 0

    @pytest.mark.asyncio
    async def test_execute_blocking_hook(self, tmp_path, monkeypatch):
        """Test that blocking hook stops execution."""
        monkeypatch.setenv("HOME", str(tmp_path))

        hooks_dir = tmp_path / ".config" / "agents" / "hooks"

        # Create two hooks: one that blocks, one that shouldn't run
        for name, decision in [("blocker", "deny"), ("after", "allow")]:
            hook_dir = hooks_dir / name
            hook_dir.mkdir(parents=True)

            (hook_dir / "HOOK.md").write_text(f"""---
name: {name}
trigger: pre-tool-call
priority: {999 if name == "blocker" else 10}
---
""")

            scripts_dir = hook_dir / "scripts"
            scripts_dir.mkdir()
            (scripts_dir / "run.sh").write_text(
                f'#!/bin/bash\necho \'{{"decision": "{decision}"}}\''
            )
            os.chmod(scripts_dir / "run.sh", 0o755)

        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery)

        result = await manager.execute("pre-tool-call", {"event_type": "pre-tool-call"})

        assert result.should_block is True
        assert len(result.results) == 1  # Only blocker ran
        assert result.results[0].hook_name == "blocker"

    @pytest.mark.asyncio
    async def test_async_hooks_fire_and_forget(self, tmp_path, monkeypatch):
        """Test that async hooks are fired as OS-level background processes."""
        monkeypatch.setenv("HOME", str(tmp_path))

        hooks_dir = tmp_path / ".config" / "agents" / "hooks"
        hook_dir = hooks_dir / "async-hook"
        hook_dir.mkdir(parents=True)

        (hook_dir / "HOOK.md").write_text("""---
name: async-hook
trigger: post-tool-call
async: true
---
""")

        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir()
        (scripts_dir / "run.sh").write_text("#!/bin/bash\necho '{\"decision\": \"allow\"}'")
        os.chmod(scripts_dir / "run.sh", 0o755)

        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery)

        result = await manager.execute("post-tool-call", {"event_type": "post-tool-call"})

        # Async hooks don't populate results list (they run as independent OS processes)
        assert len(result.results) == 0
        # Async hooks run as OS processes, not asyncio tasks
        assert result.async_tasks == []

    @pytest.mark.asyncio
    async def test_debug_mode(self, tmp_path, monkeypatch):
        """Test debug mode logging."""
        monkeypatch.setenv("HOME", str(tmp_path))

        hooks_dir = tmp_path / ".config" / "agents" / "hooks"
        hook_dir = hooks_dir / "test-hook"
        hook_dir.mkdir(parents=True)

        (hook_dir / "HOOK.md").write_text("""---
name: test-hook
trigger: pre-tool-call
---
""")

        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir()
        (scripts_dir / "run.sh").write_text("#!/bin/bash\necho '{\"decision\": \"allow\"}'")
        os.chmod(scripts_dir / "run.sh", 0o755)

        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery, debug=True)

        await manager.execute("pre-tool-call", {"event_type": "pre-tool-call"})

        stats = manager.get_debug_stats()
        assert stats["total_executions"] == 1

    @pytest.mark.asyncio
    async def test_with_runtime(self, tmp_path):
        """Test creating manager with runtime."""
        discovery = HookDiscovery(tmp_path)
        mock_runtime = MagicMock()

        manager = HookManager(discovery, runtime=mock_runtime)
        assert manager.runtime == mock_runtime

        # Test with_runtime method
        new_runtime = MagicMock()
        new_manager = manager.with_runtime(new_runtime)
        assert new_manager.runtime == new_runtime

    @pytest.mark.asyncio
    async def test_cleanup(self, tmp_path):
        """Test cleanup (no-op for OS-level async hooks)."""
        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery)

        # Cleanup should not raise (async hooks run as independent OS processes)
        await manager.cleanup()

    @pytest.mark.asyncio
    async def test_hook_error_handling(self, tmp_path, monkeypatch):
        """Test that hook errors are handled gracefully."""
        monkeypatch.setenv("HOME", str(tmp_path))

        hooks_dir = tmp_path / ".config" / "agents" / "hooks"
        hook_dir = hooks_dir / "failing-hook"
        hook_dir.mkdir(parents=True)

        (hook_dir / "HOOK.md").write_text("""---
name: failing-hook
trigger: pre-tool-call
---
""")

        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir()
        # Script with syntax error
        (scripts_dir / "run.sh").write_text("#!/bin/bash\nexit 1")
        os.chmod(scripts_dir / "run.sh", 0o755)

        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery)

        result = await manager.execute("pre-tool-call", {"event_type": "pre-tool-call"})

        # Should not raise, should return failure result
        assert len(result.results) == 1
        assert result.results[0].success is False
        assert result.should_block is False  # Fail open


# =============================================================================
# Integration Tests
# =============================================================================


class TestAgentHooksIntegration:
    """End-to-end integration tests."""

    @pytest.mark.asyncio
    async def test_full_hook_lifecycle(self, tmp_path, monkeypatch):
        """Test complete hook lifecycle from discovery to execution."""
        monkeypatch.setenv("HOME", str(tmp_path))

        # Create a complete hook setup
        hooks_dir = tmp_path / ".config" / "agents" / "hooks"
        hook_dir = hooks_dir / "security-check"
        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir(parents=True)

        # Write HOOK.md
        # Note: matcher.tool filters which tools trigger the hook
        # The hook script itself checks for dangerous patterns
        (hook_dir / "HOOK.md").write_text("""---
name: security-check
description: Security check for dangerous commands
trigger: pre-tool-call
matcher:
  tool: Shell
timeout: 5000
priority: 999
---

# Security Check

This hook prevents dangerous system commands.

## Exit Codes

- 0: Command is safe
- 2: Command is dangerous and should be blocked
""")

        # Write the script
        (scripts_dir / "run.sh").write_text(r"""#!/bin/bash
# Read event from stdin
event=$(cat)

# Check for dangerous patterns
if echo "$event" | grep -qE '"command":\s*".*(rm -rf|sudo|mkfs)'; then
    echo "Dangerous command detected" >&2
    exit 2
fi

# Allow
echo '{"decision": "allow"}'
exit 0
""")
        os.chmod(scripts_dir / "run.sh", 0o755)

        # Discover hooks
        discovery = HookDiscovery(tmp_path)
        hooks = discovery.discover()

        assert len(hooks) == 1
        assert hooks[0].name == "security-check"
        assert hooks[0].metadata.trigger == "pre-tool-call"
        assert hooks[0].metadata.priority == 999

        # Execute with safe command
        manager = HookManager(discovery)
        result = await manager.execute(
            "pre-tool-call",
            {
                "event_type": "pre-tool-call",
                "timestamp": "2024-01-01T00:00:00",
                "session_id": "test-session",
                "work_dir": str(tmp_path),
                "tool_name": "Shell",
                "tool_input": {"command": "ls -la"},
            },
            tool_name="Shell",
            tool_input={"command": "ls -la"},
        )

        assert result.should_block is False
        assert len(result.results) == 1
        assert result.results[0].decision == "allow"

        # Execute with dangerous command
        result = await manager.execute(
            "pre-tool-call",
            {
                "event_type": "pre-tool-call",
                "timestamp": "2024-01-01T00:00:00",
                "session_id": "test-session",
                "work_dir": str(tmp_path),
                "tool_name": "Shell",
                "tool_input": {"command": "rm -rf /"},
            },
            tool_name="Shell",
            tool_input={"command": "rm -rf /"},
        )

        assert result.should_block is True
        assert "Dangerous" in result.block_reason

    @pytest.mark.asyncio
    @pytest.mark.asyncio
    async def test_async_hook_execution(self, tmp_path, monkeypatch):
        """Test async hook execution as OS-level background process."""
        monkeypatch.setenv("HOME", str(tmp_path))

        hooks_dir = tmp_path / ".config" / "agents" / "hooks"
        hook_dir = hooks_dir / "async-writer"
        scripts_dir = hook_dir / "scripts"
        scripts_dir.mkdir(parents=True)

        # Create an async hook
        (hook_dir / "HOOK.md").write_text("""---
name: async-writer
description: Async file writer hook
trigger: post-tool-call
async: true
---

Async file writer.
""")

        # Create a script that writes to a log file
        log_file = tmp_path / "async_test.log"
        (scripts_dir / "run.sh").write_text(f"""#!/bin/bash
cat > {log_file}
""")
        os.chmod(scripts_dir / "run.sh", 0o755)

        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery)

        # Execute the async hook (runs as OS-level background process)
        result = await manager.execute(
            "post-tool-call",
            {
                "event_type": "post-tool-call",
                "tool_name": "Shell",
                "tool_input": {"command": "ls"},
            },
        )

        # Async hooks return immediately (run as OS processes, not asyncio tasks)
        assert len(result.results) == 0
        assert result.async_tasks == []

        # Wait for async process to complete and verify file was written
        await asyncio.sleep(1.0)
        assert log_file.exists(), "Async hook should have written the file"
        content = log_file.read_text()
        assert "post-tool-call" in content, "Log should contain event data"

        # Cleanup
        log_file.unlink()

    def test_hook_directory_structure(self, tmp_path):
        """Test typical AgentHooks directory structure."""
        # Create multiple hooks
        hooks = [
            ("block-dangerous", "pre-tool-call"),
            ("auto-format", "post-tool-call"),
            ("session-logger", "pre-session"),
        ]

        hooks_dir = tmp_path / "hooks"

        for name, trigger in hooks:
            hook_dir = hooks_dir / name
            scripts_dir = hook_dir / "scripts"
            scripts_dir.mkdir(parents=True)

            (hook_dir / "HOOK.md").write_text(f"""---
name: {name}
trigger: {trigger}
---

{name} hook.
""")

            (scripts_dir / "run.sh").write_text("#!/bin/bash\necho '{\"decision\": \"allow\"}'")
            os.chmod(scripts_dir / "run.sh", 0o755)

        # Parse all hooks
        discovered = []
        for hook_dir in hooks_dir.iterdir():
            if hook_dir.is_dir():
                hook = HookParser.parse(hook_dir)
                discovered.append(hook)

        assert len(discovered) == 3
        triggers = {h.metadata.trigger for h in discovered}
        assert triggers == {"pre-tool-call", "post-tool-call", "pre-session"}

    @pytest.mark.asyncio
    async def test_project_overrides_user(self, tmp_path, monkeypatch):
        """Test that project hooks override user hooks."""
        monkeypatch.setenv("HOME", str(tmp_path))

        # Create user-level hook
        user_hooks = tmp_path / ".config" / "agents" / "hooks"
        user_hook = user_hooks / "shared"
        user_scripts = user_hook / "scripts"
        user_scripts.mkdir(parents=True)

        (user_hook / "HOOK.md").write_text("""---
name: shared
trigger: pre-tool-call
---

User hook.
""")
        (user_scripts / "run.sh").write_text("#!/bin/bash\necho '{\"decision\": \"allow\", \"additional_context\": \"user\"}'")
        os.chmod(user_scripts / "run.sh", 0o755)

        # Create project-level hook with same name
        work_dir = tmp_path / "project"
        project_hooks = work_dir / ".agents" / "hooks"
        project_hook = project_hooks / "shared"
        project_scripts = project_hook / "scripts"
        project_scripts.mkdir(parents=True)

        (project_hook / "HOOK.md").write_text("""---
name: shared
trigger: pre-tool-call
---

Project hook.
""")
        (project_scripts / "run.sh").write_text("#!/bin/bash\necho '{\"decision\": \"allow\", \"additional_context\": \"project\"}'")
        os.chmod(project_scripts / "run.sh", 0o755)

        # Discover and execute
        discovery = HookDiscovery(work_dir)
        manager = HookManager(discovery)

        result = await manager.execute("pre-tool-call", {"event_type": "pre-tool-call"})

        # Should use project hook
        assert len(result.results) == 1
        assert result.additional_contexts == ["project"]

    @pytest.mark.asyncio
    async def test_priority_ordering(self, tmp_path, monkeypatch):
        """Test that hooks execute in priority order."""
        monkeypatch.setenv("HOME", str(tmp_path))

        hooks_dir = tmp_path / ".config" / "agents" / "hooks"
        order_file = tmp_path / "execution_order.txt"

        # Create hooks with different priorities
        for name, priority in [("low", 10), ("high", 999), ("medium", 100)]:
            hook_dir = hooks_dir / name
            scripts_dir = hook_dir / "scripts"
            scripts_dir.mkdir(parents=True)

            (hook_dir / "HOOK.md").write_text(f"""---
name: {name}
trigger: pre-tool-call
priority: {priority}
---
""")

            # Script that appends its name to order file
            (scripts_dir / "run.sh").write_text(f"""#!/bin/bash
echo "{name}" >> {order_file}
echo '{{"decision": "allow"}}'
""")
            os.chmod(scripts_dir / "run.sh", 0o755)

        discovery = HookDiscovery(tmp_path)
        manager = HookManager(discovery)

        await manager.execute("pre-tool-call", {"event_type": "pre-tool-call"})

        # Check execution order (high priority first)
        order = order_file.read_text().strip().split("\n")
        assert order == ["high", "medium", "low"]

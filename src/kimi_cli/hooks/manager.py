"""Hook manager for AgentHooks standard."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from kimi_cli.hooks.discovery import HookDiscovery
from kimi_cli.hooks.executor import ExecutionResult, HookExecutor, HooksExecutionResult
from kimi_cli.hooks.parser import Matcher, ParsedHook
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.soul.agent import Runtime


@dataclass
class HookDebugLog:
    """Debug log entry for hook execution."""

    timestamp: str
    event_type: str
    hook_name: str
    input_context: dict[str, Any]
    result: ExecutionResult | None = None
    duration_ms: int = 0
    error: str | None = None
    is_async: bool = False


class HookDebugger:
    """Debug logging for hooks."""

    def __init__(self, enabled: bool = False):
        self.enabled = enabled
        self.logs: list[HookDebugLog] = []

    def log_start(
        self,
        event_type: str,
        hook_name: str,
        input_context: dict[str, Any],
        is_async: bool = False,
    ) -> HookDebugLog:
        """Log the start of hook execution."""
        log = HookDebugLog(
            timestamp=datetime.now().isoformat(),
            event_type=event_type,
            hook_name=hook_name,
            input_context=input_context,
            is_async=is_async,
        )
        self.logs.append(log)

        if self.enabled:
            mode = "[ASYNC]" if is_async else "[SYNC]"
            logger.info(
                "[HOOK DEBUG] {mode} Starting hook '{hook_name}' for event '{event}'",
                mode=mode,
                hook_name=hook_name,
                event=event_type,
            )

        return log

    def log_complete(self, log: HookDebugLog, result: ExecutionResult) -> None:
        """Log the completion of hook execution."""
        log.result = result
        log.duration_ms = result.duration_ms

        if self.enabled:
            mode = "[ASYNC]" if log.is_async else "[SYNC]"
            logger.info(
                "[HOOK DEBUG] {mode} Completed hook '{hook_name}' in {duration}ms: "
                "decision={decision}",
                mode=mode,
                hook_name=result.hook_name,
                duration=result.duration_ms,
                decision=result.decision,
            )
            if result.reason:
                logger.info("[HOOK DEBUG] Reason: {reason}", reason=result.reason)

    def log_error(self, log: HookDebugLog, error: str) -> None:
        """Log an error during hook execution."""
        log.error = error
        if self.enabled:
            logger.error(
                "[HOOK DEBUG] Hook '{hook_name}' failed: {error}",
                hook_name=log.hook_name,
                error=error,
            )

    def get_statistics(self) -> dict[str, Any]:
        """Get execution statistics."""
        if not self.logs:
            return {"total_executions": 0}

        total = len(self.logs)
        successful = sum(1 for log in self.logs if log.result and log.result.success)
        blocked = sum(1 for log in self.logs if log.result and log.result.should_block)
        async_count = sum(1 for log in self.logs if log.is_async)
        total_duration = sum(log.duration_ms for log in self.logs if log.result)

        return {
            "total_executions": total,
            "successful": successful,
            "failed": total - successful,
            "blocked": blocked,
            "async": async_count,
            "total_duration_ms": total_duration,
        }


class HookManager:
    """Manages hook discovery and execution following AgentHooks standard."""

    def __init__(
        self,
        discovery: HookDiscovery,
        runtime: Runtime | None = None,
        debug: bool = False,
    ):
        self.discovery = discovery
        self.runtime = runtime
        self.executor = HookExecutor(runtime)
        self.debugger = HookDebugger(enabled=debug)
        self._async_tasks: set[asyncio.Task] = set()

    def with_runtime(self, runtime: Runtime) -> HookManager:
        """Create a new HookManager with runtime context."""
        return HookManager(
            discovery=self.discovery,
            runtime=runtime,
            debug=self.debugger.enabled,
        )

    def enable_debug(self, enabled: bool = True) -> None:
        """Enable or disable debug logging."""
        self.debugger.enabled = enabled

    async def execute(
        self,
        event_type: str,
        event: dict[str, Any],
        *,
        tool_name: str | None = None,
        tool_input: dict[str, Any] | None = None,
    ) -> HooksExecutionResult:
        """Execute all matching hooks for the event.

        Args:
            event_type: Type of event (e.g., 'before_tool', 'session_start')
            event: Event data dictionary
            tool_name: Optional tool name for filtering
            tool_input: Optional tool input for filtering

        Returns:
            HooksExecutionResult with all execution results
        """
        # Get hooks for this trigger
        hooks = self.discovery.discover_by_trigger(event_type)

        if not hooks:
            return HooksExecutionResult(results=[])

        # Filter by matcher
        matching_hooks = []
        for hook in hooks:
            if hook.metadata.matcher:
                matcher = Matcher(
                    tool=hook.metadata.matcher.get("tool"),
                    pattern=hook.metadata.matcher.get("pattern"),
                )
                if not matcher.matches(tool_name, tool_input):
                    continue
            matching_hooks.append(hook)

        if not matching_hooks:
            return HooksExecutionResult(results=[])

        logger.debug(
            "Executing {count} hooks for event {event}",
            count=len(matching_hooks),
            event=event_type,
        )

        # Separate sync and async hooks
        sync_hooks = [h for h in matching_hooks if not h.metadata.async_]
        async_hooks = [h for h in matching_hooks if h.metadata.async_]

        # Execute sync hooks first
        sync_results: list[ExecutionResult] = []
        for hook in sync_hooks:
            result = await self._execute_single_hook(hook, event, is_async=False)
            sync_results.append(result)

            if result.should_block:
                logger.info(
                    "Event {event} blocked by hook {hook}: {reason}",
                    event=event_type,
                    hook=hook.name,
                    reason=result.reason,
                )
                break

        # Fire async hooks (these cannot block)
        async_tasks: list[asyncio.Task] = []
        if not any(r.should_block for r in sync_results):
            for hook in async_hooks:
                task = self._fire_async_hook(hook, event)
                async_tasks.append(task)

        result = HooksExecutionResult(results=sync_results)
        result.async_tasks = async_tasks
        return result

    async def _execute_single_hook(
        self,
        hook: ParsedHook,
        event: dict[str, Any],
        is_async: bool = False,
    ) -> ExecutionResult:
        """Execute a single hook."""
        log = self.debugger.log_start(
            event_type=event.get("event_type", "unknown"),
            hook_name=hook.name,
            input_context=event,
            is_async=is_async,
        )

        try:
            result = await self.executor.execute(hook, event)

            if not is_async:
                self.debugger.log_complete(log, result)

            return result
        except Exception as e:
            logger.exception("Hook {name} failed: {error}", name=hook.name, error=e)
            error_msg = str(e)
            self.debugger.log_error(log, error_msg)
            return ExecutionResult(
                success=False,
                hook_name=hook.name,
                duration_ms=0,
                exit_code=-1,
                stdout="",
                stderr=error_msg,
                decision="allow",  # Fail open
                reason=error_msg,
            )

    def _fire_async_hook(self, hook: ParsedHook, event: dict[str, Any]) -> asyncio.Task:
        """Fire an async hook without waiting for completion."""
        log = self.debugger.log_start(
            event_type=event.get("event_type", "unknown"),
            hook_name=hook.name,
            input_context=event,
            is_async=True,
        )

        async def run_async():
            try:
                result = await self.executor.execute(hook, event)
                self.debugger.log_complete(log, result)

                if result.should_block:
                    logger.warning(
                        "Async hook {name} returned DENY but was not blocking",
                        name=hook.name,
                    )
            except Exception as e:
                logger.exception("Async hook {name} failed: {error}", name=hook.name, error=e)
                self.debugger.log_error(log, str(e))

        task = asyncio.create_task(run_async())
        self._async_tasks.add(task)
        task.add_done_callback(self._async_tasks.discard)

        logger.debug("Fired async hook: {name}", name=hook.name)
        return task

    def get_debug_stats(self) -> dict[str, Any]:
        """Get debug statistics."""
        return self.debugger.get_statistics()

    async def cleanup(self) -> None:
        """Clean up async tasks."""
        if self._async_tasks:
            logger.debug(
                "Waiting for {count} async hook tasks to complete", count=len(self._async_tasks)
            )
            await asyncio.wait(self._async_tasks, timeout=5.0)
            for task in self._async_tasks:
                if not task.done():
                    task.cancel()
            self._async_tasks.clear()


# Backwards compatibility aliases for existing code
HooksExecutionResult = HooksExecutionResult

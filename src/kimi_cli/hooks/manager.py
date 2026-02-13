from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kimi_cli.hooks.config import HookConfig, HookEventType, HooksConfig, HookType
from kimi_cli.hooks.models import HookDecision, HookEvent, HookResult
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.soul.agent import Runtime


@dataclass
class CommandResult:
    """Result of command execution."""

    exit_code: int
    stdout: str
    stderr: str


@dataclass
class HookExecutionLog:
    """Log entry for a single hook execution."""

    timestamp: str
    event_type: str
    hook_name: str
    hook_type: str
    input_context: dict[str, Any] = field(default_factory=dict)
    result: HookResult | None = None
    duration_ms: int = 0
    error: str | None = None


class HookDebugger:
    """Debug logging for hooks."""

    def __init__(self, enabled: bool = False):
        self.enabled = enabled
        self.logs: list[HookExecutionLog] = []

    def log_start(
        self,
        event_type: HookEventType,
        hook_name: str,
        hook_type: str,
        input_context: dict[str, Any],
    ) -> HookExecutionLog:
        """Log the start of hook execution."""
        log = HookExecutionLog(
            timestamp=datetime.now().isoformat(),
            event_type=event_type.value,
            hook_name=hook_name,
            hook_type=hook_type,
            input_context=input_context,
        )
        self.logs.append(log)

        if self.enabled:
            logger.info(
                "[HOOK DEBUG] Starting {hook_type} hook '{hook_name}' for event '{event}'",
                hook_type=hook_type,
                hook_name=hook_name,
                event=event_type.value,
            )

        return log

    def log_complete(self, log: HookExecutionLog, result: HookResult) -> None:
        """Log the completion of hook execution."""
        log.result = result
        log.duration_ms = result.duration_ms

        if self.enabled:
            logger.info(
                "[HOOK DEBUG] Completed hook '{hook_name}' in {duration}ms: "
                "success={success}, decision={decision}",
                hook_name=result.hook_name,
                duration=result.duration_ms,
                success=result.success,
                decision=result.decision.value,
            )
            if result.reason:
                logger.info("[HOOK DEBUG] Reason: {reason}", reason=result.reason)

    def log_error(self, log: HookExecutionLog, error: str) -> None:
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
        denied = sum(
            1 for log in self.logs if log.result and log.result.decision == HookDecision.DENY
        )
        total_duration = sum(log.duration_ms for log in self.logs)

        by_type: dict[str, dict[str, Any]] = {}
        for log in self.logs:
            hook_type = log.hook_type
            if hook_type not in by_type:
                by_type[hook_type] = {"count": 0, "total_duration": 0, "errors": 0}
            by_type[hook_type]["count"] += 1
            by_type[hook_type]["total_duration"] += log.duration_ms
            if log.error:
                by_type[hook_type]["errors"] += 1

        return {
            "total_executions": total,
            "successful": successful,
            "failed": total - successful,
            "denied": denied,
            "total_duration_ms": total_duration,
            "by_type": by_type,
        }


class HookExecutor:
    """Executor for command-type hooks."""

    def __init__(self, env_file: str | None = None, runtime: Runtime | None = None):
        self.env_file = env_file
        self.runtime = runtime

    async def execute(
        self,
        hook: HookConfig,
        event: HookEvent,
        runtime: Runtime | None,
    ) -> HookResult:
        """Execute a command hook."""
        # Prepare environment
        env = os.environ.copy()
        if runtime:
            env["KIMI_SESSION_ID"] = runtime.session.session_id
            env["KIMI_WORK_DIR"] = str(runtime.session.work_dir)
            env["KIMI_PROJECT_DIR"] = str(runtime.session.work_dir)
            if self.env_file:
                env["KIMI_ENV_FILE"] = self.env_file

        # Prepare JSON input
        input_data = json.dumps(
            {
                "event_type": event.event_type,
                "timestamp": event.timestamp.isoformat(),
                "session_id": event.session_id,
                "work_dir": event.work_dir,
                **event.context,
            }
        )

        # Execute command
        proc = await asyncio.create_subprocess_shell(
            hook.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=input_data.encode()),
                timeout=hook.timeout / 1000,  # Convert to seconds
            )
        except TimeoutError:
            proc.kill()
            raise

        return self._parse_result(
            hook,
            CommandResult(
                exit_code=proc.returncode or 0,
                stdout=stdout.decode(),
                stderr=stderr.decode(),
            ),
        )

    def _parse_result(self, hook: HookConfig, result: CommandResult) -> HookResult:
        """Parse command execution result."""
        # Exit code 2 = blocking error (System Block)
        if result.exit_code == 2:
            return HookResult(
                success=True,
                hook_name=hook.name or "unknown",
                hook_type=hook.type.value,
                duration_ms=0,
                exit_code=2,
                stderr=result.stderr,
                decision=HookDecision.DENY,
                reason=result.stderr or "Blocked by hook",
            )

        # Exit code 0 = success, parse JSON from stdout
        if result.exit_code == 0:
            try:
                output = json.loads(result.stdout) if result.stdout.strip() else {}
            except json.JSONDecodeError:
                # Non-JSON output treated as additional context
                output = {"additional_context": result.stdout}

            return HookResult(
                success=True,
                hook_name=hook.name or "unknown",
                hook_type=hook.type.value,
                duration_ms=0,
                exit_code=0,
                stdout=result.stdout,
                stderr=result.stderr,
                decision=HookDecision(output.get("decision", "allow")),
                reason=output.get("reason"),
                modified_input=output.get("modified_input"),
                additional_context=output.get("additional_context"),
            )

        # Other exit codes = non-blocking error (Warning)
        return HookResult(
            success=False,
            hook_name=hook.name or "unknown",
            hook_type=hook.type.value,
            duration_ms=0,
            exit_code=result.exit_code,
            stdout=result.stdout,
            stderr=result.stderr,
            decision=HookDecision.ALLOW,
            reason=f"Hook exited with code {result.exit_code}",
        )


class HookManager:
    """Manages hook registration and execution."""

    def __init__(
        self,
        config: HooksConfig | None = None,
        runtime: Runtime | None = None,
        debug: bool = False,
    ) -> None:
        self._config = config or HooksConfig()
        self._runtime = runtime
        self._env_file: str | None = None
        self._debugger = HookDebugger(enabled=debug)

        # Initialize executor
        self._executor: HookExecutor | None = None

    def with_runtime(self, runtime: Runtime) -> HookManager:
        """Create a new HookManager with runtime context."""
        manager = HookManager(self._config, runtime, self._debugger.enabled)
        if runtime:
            manager._env_file = self._get_env_file_path(runtime)
            manager._executor = HookExecutor(manager._env_file, runtime)
        return manager

    def enable_debug(self, enabled: bool = True) -> None:
        """Enable or disable debug logging."""
        self._debugger.enabled = enabled

    def _get_env_file_path(self, runtime: Runtime) -> str:
        """Get path for environment file (KIMI_ENV_FILE mechanism)."""
        env_file = Path(runtime.session.work_dir) / ".kimi" / "env"
        env_file.parent.mkdir(parents=True, exist_ok=True)
        return str(env_file)

    def load_env_file(self) -> dict[str, str]:
        """Load environment variables from KIMI_ENV_FILE."""
        env_vars: dict[str, str] = {}
        if not self._env_file or not Path(self._env_file).exists():
            return env_vars

        try:
            content = Path(self._env_file).read_text(encoding="utf-8")
            for line in content.strip().splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, value = line.split("=", 1)
                    # Remove quotes if present
                    value = value.strip().strip('"')
                    env_vars[key.strip()] = value
        except Exception:
            logger.debug("Failed to load env file: {file}", file=self._env_file)

        return env_vars

    async def execute(
        self,
        event_type: HookEventType,
        event: HookEvent,
        *,
        tool_name: str | None = None,
        tool_input: dict[str, Any] | None = None,
    ) -> list[HookResult]:
        """Execute all matching hooks for the event."""
        hooks = self._get_hooks_for_event(event_type)
        if not hooks:
            return []

        # Filter by matcher
        matching_hooks = [
            hook
            for hook in hooks
            if hook.matcher is None or hook.matcher.matches(tool_name, tool_input)
        ]

        if not matching_hooks:
            return []

        logger.debug(
            "Executing {count} hooks for event {event}",
            count=len(matching_hooks),
            event=event_type.value,
        )

        # Execute hooks in parallel
        tasks = [self._execute_hook(hook, event) for hook in matching_hooks]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        return [
            result if isinstance(result, HookResult) else self._error_to_result(result)
            for result in results
        ]

    async def _execute_hook(self, hook: HookConfig, event: HookEvent) -> HookResult:
        """Execute a single hook."""
        start_time = time.monotonic()

        # Prepare input context for debugging
        input_context = {
            "event_type": event.event_type,
            "session_id": event.session_id,
            **event.context,
        }

        log = self._debugger.log_start(
            HookEventType(event.event_type),
            hook.name or "unknown",
            hook.type.value,
            input_context,
        )

        try:
            if hook.type == HookType.COMMAND:
                result = await self._execute_with_timeout(
                    self._execute_command_hook(hook, event),
                    hook.timeout,
                )
            else:
                raise ValueError(f"Unknown hook type: {hook.type}")

            # Update duration
            duration_ms = int((time.monotonic() - start_time) * 1000)
            result = self._update_duration(result, duration_ms)

            self._debugger.log_complete(log, result)
            return result

        except TimeoutError:
            duration_ms = int((time.monotonic() - start_time) * 1000)
            logger.warning(
                "Hook {name} timed out after {timeout}ms",
                name=hook.name,
                timeout=hook.timeout,
            )
            result = HookResult(
                success=False,
                hook_name=hook.name or "unknown",
                hook_type=hook.type.value,
                duration_ms=duration_ms,
                decision=HookDecision.ALLOW,  # Fail open on timeout
                reason=f"Hook timed out after {hook.timeout}ms",
            )
            self._debugger.log_complete(log, result)
            return result
        except Exception as e:
            duration_ms = int((time.monotonic() - start_time) * 1000)
            logger.exception("Hook {name} failed: {error}", name=hook.name, error=e)
            error_msg = str(e)
            self._debugger.log_error(log, error_msg)
            return HookResult(
                success=False,
                hook_name=hook.name or "unknown",
                hook_type=hook.type.value,
                duration_ms=duration_ms,
                decision=HookDecision.ALLOW,
                reason=error_msg,
            )

    async def _execute_with_timeout(self, coro, timeout_ms: int) -> HookResult:
        """Execute a coroutine with timeout."""
        return await asyncio.wait_for(coro, timeout=timeout_ms / 1000)

    def _update_duration(self, result: HookResult, duration_ms: int) -> HookResult:
        """Update the duration in a HookResult."""
        # Since HookResult is frozen, we need to create a new one
        return replace(result, duration_ms=duration_ms)

    def _get_hooks_for_event(self, event_type: HookEventType) -> list[HookConfig]:
        """Get hooks for a specific event type."""
        return getattr(self._config, event_type.value, [])

    def _error_to_result(self, error: Exception) -> HookResult:
        """Convert exception to HookResult."""
        return HookResult(
            success=False,
            hook_name="unknown",
            hook_type="unknown",
            duration_ms=0,
            decision=HookDecision.ALLOW,
            reason=str(error),
        )

    def get_debug_stats(self) -> dict[str, Any]:
        """Get debug statistics."""
        return self._debugger.get_statistics()

    def get_debug_logs(self) -> list[HookExecutionLog]:
        """Get all debug logs."""
        return self._debugger.logs.copy()

    # Backwards compatibility methods for tests
    async def _execute_command_hook(
        self,
        hook: HookConfig,
        event: HookEvent,
    ) -> HookResult:
        """Execute a command hook (backwards compatibility)."""
        if not self._executor:
            # Create a temporary executor without runtime for tests
            self._executor = HookExecutor(self._env_file, self._runtime)
        return await self._executor.execute(hook, event, self._runtime)

    def _parse_command_result(
        self,
        hook: HookConfig,
        result: CommandResult,
    ) -> HookResult:
        """Parse command execution result (backwards compatibility)."""
        if not self._executor:
            self._executor = HookExecutor(self._env_file, self._runtime)
        return self._executor._parse_result(hook, result)

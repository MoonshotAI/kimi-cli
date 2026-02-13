from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kimi_cli.hooks.config import (
    CommandHookConfig,
    HookConfig,
    HookEventType,
    HooksConfig,
    HookType,
)
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


class HookManager:
    """Manages hook registration and execution."""

    def __init__(self, config: HooksConfig | None = None, runtime: Runtime | None = None) -> None:
        self._config = config or HooksConfig()
        self._runtime = runtime
        self._env_file: str | None = None

    def with_runtime(self, runtime: Runtime) -> HookManager:
        """Create a new HookManager with runtime context."""
        manager = HookManager(self._config, runtime)
        if runtime:
            manager._env_file = self._get_env_file_path(runtime)
        return manager

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
                    value = value.strip().strip("'\"")
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
        import time

        start_time = time.monotonic()

        try:
            if hook.type == HookType.COMMAND:
                result = await self._execute_command_hook(hook, event)
            else:
                raise ValueError(f"Unknown hook type: {hook.type}")

            return result

        except TimeoutError:
            logger.warning(
                "Hook {name} timed out after {timeout}ms",
                name=hook.name,
                timeout=hook.timeout,
            )
            return HookResult(
                success=False,
                hook_name=hook.name or "unknown",
                hook_type=hook.type.value,
                duration_ms=hook.timeout,
                decision=HookDecision.ALLOW,  # Fail open on timeout
                reason=f"Hook timed out after {hook.timeout}ms",
            )
        except Exception as e:
            logger.exception("Hook {name} failed: {error}", name=hook.name, error=e)
            return HookResult(
                success=False,
                hook_name=hook.name or "unknown",
                hook_type=hook.type.value,
                duration_ms=int((time.monotonic() - start_time) * 1000),
                decision=HookDecision.ALLOW,
                reason=str(e),
            )

    async def _execute_command_hook(
        self,
        hook: CommandHookConfig,
        event: HookEvent,
    ) -> HookResult:
        """Execute a command hook."""
        # Prepare environment
        env = os.environ.copy()
        if self._runtime:
            env["KIMI_SESSION_ID"] = self._runtime.session.session_id
            env["KIMI_WORK_DIR"] = str(self._runtime.session.work_dir)
            env["KIMI_PROJECT_DIR"] = str(self._runtime.session.work_dir)
            if self._env_file:
                env["KIMI_ENV_FILE"] = self._env_file

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

        return self._parse_command_result(
            hook,
            CommandResult(
                exit_code=proc.returncode or 0,
                stdout=stdout.decode(),
                stderr=stderr.decode(),
            ),
        )

    def _parse_command_result(
        self,
        hook: CommandHookConfig,
        result: CommandResult,
    ) -> HookResult:
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

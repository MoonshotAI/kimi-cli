"""Hook executor for running external hook scripts."""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kimi_cli.hooks.parser import Matcher, ParsedHook
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.soul.agent import Runtime


@dataclass(frozen=True, slots=True)
class CommandResult:
    """Result of command execution."""

    exit_code: int
    stdout: str
    stderr: str


@dataclass(frozen=True, slots=True)
class ExecutionResult:
    """Result of hook execution."""

    success: bool
    hook_name: str
    duration_ms: int
    exit_code: int
    stdout: str
    stderr: str
    # Decision fields
    decision: str = "allow"  # "allow", "deny", "ask"
    reason: str | None = None
    modified_input: dict[str, Any] | None = None
    additional_context: str | None = None
    # Blocking
    should_block: bool = False


class HookExecutor:
    """Executor for running external hook scripts following AgentHooks protocol."""

    def __init__(self, runtime: Runtime | None = None):
        self.runtime = runtime

    async def execute(
        self,
        hook: ParsedHook,
        event: dict[str, Any],
    ) -> ExecutionResult:
        """Execute a hook with the given event data.

        Args:
            hook: Parsed hook definition
            event: Event data to pass via stdin as JSON

        Returns:
            ExecutionResult with parsed output
        """
        entry_point = hook.find_entry_point()
        if entry_point is None:
            return ExecutionResult(
                success=False,
                hook_name=hook.name,
                duration_ms=0,
                exit_code=-1,
                stdout="",
                stderr="No entry point found (scripts/run, scripts/run.sh, or scripts/run.py)",
                decision="allow",  # Fail open
                reason="No hook entry point",
            )

        start_time = asyncio.get_event_loop().time()

        # Prepare environment
        env = os.environ.copy()
        if self.runtime:
            env["KIMI_SESSION_ID"] = self.runtime.session.id
            env["KIMI_WORK_DIR"] = str(self.runtime.session.work_dir)
            env["KIMI_PROJECT_DIR"] = str(self.runtime.session.work_dir)

        # Prepare JSON input
        input_data = json.dumps(event, default=str)

        try:
            proc = await asyncio.create_subprocess_shell(
                str(entry_point),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=str(hook.path),
            )

            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=input_data.encode()),
                timeout=hook.metadata.timeout / 1000,
            )

            duration_ms = int((asyncio.get_event_loop().time() - start_time) * 1000)

            return self._parse_result(
                hook,
                CommandResult(
                    exit_code=proc.returncode or 0,
                    stdout=stdout.decode(),
                    stderr=stderr.decode(),
                ),
                duration_ms,
            )

        except TimeoutError:
            proc.kill()
            duration_ms = int((asyncio.get_event_loop().time() - start_time) * 1000)
            return ExecutionResult(
                success=False,
                hook_name=hook.name,
                duration_ms=duration_ms,
                exit_code=-1,
                stdout="",
                stderr=f"Hook timed out after {hook.metadata.timeout}ms",
                decision="allow",  # Fail open on timeout
                reason=f"Timeout ({hook.metadata.timeout}ms)",
            )
        except Exception as e:
            duration_ms = int((asyncio.get_event_loop().time() - start_time) * 1000)
            logger.exception("Hook execution failed: {hook}", hook=hook.name)
            return ExecutionResult(
                success=False,
                hook_name=hook.name,
                duration_ms=duration_ms,
                exit_code=-1,
                stdout="",
                stderr=str(e),
                decision="allow",  # Fail open on error
                reason=str(e),
            )

    def _parse_result(
        self,
        hook: ParsedHook,
        result: CommandResult,
        duration_ms: int,
    ) -> ExecutionResult:
        """Parse command execution result following AgentHooks protocol.

        Exit code semantics:
        - 0: Success, parse stdout JSON for decision
        - 2: Block - block the action, stderr as reason
        - other: Non-blocking error - log warning, continue
        """
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()

        # Exit code 2 = blocking error (System Block)
        if result.exit_code == 2:
            return ExecutionResult(
                success=True,  # Execution succeeded in blocking
                hook_name=hook.name,
                duration_ms=duration_ms,
                exit_code=2,
                stdout=stdout,
                stderr=stderr,
                decision="deny",
                reason=stderr or "Blocked by hook (exit code 2)",
                should_block=True,
            )

        # Exit code 0 = success, parse JSON from stdout
        if result.exit_code == 0:
            return self._parse_success_result(hook, result, duration_ms)

        # Other exit codes = non-blocking error (Warning)
        return ExecutionResult(
            success=False,
            hook_name=hook.name,
            duration_ms=duration_ms,
            exit_code=result.exit_code,
            stdout=stdout,
            stderr=stderr,
            decision="allow",  # Fail open
            reason=f"Hook exited with code {result.exit_code}: {stderr}",
        )

    def _parse_success_result(
        self,
        hook: ParsedHook,
        result: CommandResult,
        duration_ms: int,
    ) -> ExecutionResult:
        """Parse successful execution result (exit code 0)."""
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()

        # Try to parse JSON from stdout
        if stdout:
            try:
                output = json.loads(stdout)
            except json.JSONDecodeError:
                # Non-JSON output treated as additional context
                output = {"additional_context": stdout}
        else:
            output = {}

        # Extract decision from JSON
        decision = output.get("decision", "allow")
        if decision not in ("allow", "deny", "ask"):
            logger.warning(
                "Hook '{name}' returned invalid decision '{decision}', defaulting to allow",
                name=hook.name,
                decision=decision,
            )
            decision = "allow"

        should_block = decision == "deny"

        return ExecutionResult(
            success=True,
            hook_name=hook.name,
            duration_ms=duration_ms,
            exit_code=0,
            stdout=result.stdout,
            stderr=stderr,
            decision=decision,
            reason=output.get("reason"),
            modified_input=output.get("modified_input"),
            additional_context=output.get("additional_context"),
            should_block=should_block,
        )


class HooksExecutionResult:
    """Result of executing multiple hooks for an event."""

    def __init__(self, results: list[ExecutionResult]):
        self.results = results
        self.should_block = any(r.should_block for r in results)
        # Find block reason from first blocking result
        self.block_reason: str | None = None
        for r in results:
            if r.should_block:
                self.block_reason = r.reason or f"Blocked by hook '{r.hook_name}'"
                break
        self.additional_contexts = [
            r.additional_context for r in results if r.additional_context
        ]

        # Track async tasks for cleanup
        self.async_tasks: list[asyncio.Task] = []

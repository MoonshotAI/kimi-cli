"""Plan execution engine with parallel execution, retries, and checkpoints.

This module provides the main PlanExecutor class that orchestrates plan execution,
including parallel step execution, automatic retries with exponential backoff,
checkpoint management for resumability, and user interaction on failures.
"""

import asyncio
import time
from datetime import datetime
from typing import Callable

from kimi_cli.plans.models import Plan, PlanStep, PlanExecution, StepExecution
from kimi_cli.plans.checkpoint import CheckpointManager
from kimi_cli.plans.step_runner import StepRunner
from kimi_cli.plans.strategies import get_strategy, get_strategy_name
from kimi_cli.plans.errors import (
    PlansError,
    LLMTimeoutError,
    LLMRateLimitError,
    LLMError,
    DiskFullError,
    CheckpointCorruptedError,
    ExecutionAborted,
    NetworkError,
    StepExecutionError,
)


class PlanExecutor:
    """Execute plans with parallel steps, retries, and checkpoints."""
    
    def __init__(
        self,
        llm,
        max_parallel: int = None,
        enable_checkpoints: bool = True,
    ):
        self._llm = llm
        self._max_parallel_override = max_parallel
        self._enable_checkpoints = enable_checkpoints
        self._checkpoint_manager = CheckpointManager() if enable_checkpoints else None
        self._step_runner = StepRunner(llm)
        
        # Strategy (set during execute based on plan size)
        self._strategy = None
        self._checkpoint_frequency = 1
        self._wave_count = 0
        
        # Graceful shutdown
        self._shutdown_requested = False
        self._current_execution = None
        self._emergency_save_attempted = False
        
        # Event listeners
        self._on_step_start: list[Callable[[StepExecution], None]] = []
        self._on_step_complete: list[Callable[[StepExecution], None]] = []
        self._on_step_failed: list[Callable[[StepExecution], None]] = []
        self._on_retry: list[Callable[[str, int, str], None]] = []  # step_id, attempt, reason
    
    def request_shutdown(self):
        """Request graceful shutdown - saves checkpoint if possible."""
        self._shutdown_requested = True
        if self._current_execution and not self._emergency_save_attempted:
            self._emergency_checkpoint()
    
    def _emergency_checkpoint(self):
        """Save current state on shutdown (best effort)."""
        if not self._current_execution or not self._checkpoint_manager:
            return
        
        self._emergency_save_attempted = True
        try:
            self._checkpoint_manager.save(self._current_execution)
            self._show_message(
                "\n[yellow]⚠️ Execution interrupted. State saved. "
                "Resume with /plan-execute --resume[/yellow]"
            )
        except Exception:
            pass  # Best effort - don't fail during shutdown
    
    def _show_message(self, message: str):
        """Show message to user (can be overridden)."""
        # Default implementation - can be enhanced with Rich/console output
        print(message)
    
    def _show_retry_message(self, message: str):
        """Show retry notification."""
        self._show_message(f"[dim]{message}[/dim]")
    
    def _show_error(self, message: str):
        """Show error message."""
        self._show_message(f"[red]{message}[/red]")
    
    def add_listener(self, event: str, callback: Callable):
        """Add event listener.
        
        Events: "step_start", "step_complete", "step_failed", "retry"
        """
        if event == "step_start":
            self._on_step_start.append(callback)
        elif event == "step_complete":
            self._on_step_complete.append(callback)
        elif event == "step_failed":
            self._on_step_failed.append(callback)
        elif event == "retry":
            self._on_retry.append(callback)
    
    async def execute(
        self,
        plan: Plan,
        resume: bool = False,
        fresh: bool = False,
    ) -> PlanExecution:
        """Execute plan with checkpoint support.
        
        Args:
            plan: Plan to execute
            resume: Resume from checkpoint if exists
            fresh: Start fresh, ignore checkpoint
            
        Returns:
            PlanExecution with final state
            
        Raises:
            ExecutionAborted: If user aborts
        """
        # Select strategy based on plan size
        plan_size = len(plan.steps)
        self._strategy = get_strategy(plan_size)
        self._checkpoint_frequency = self._strategy.get_checkpoint_frequency()
        
        # Determine start state
        execution = self._initialize_execution(plan, resume, fresh)
        self._current_execution = execution
        self._wave_count = 0
        
        # Get execution order (waves of parallel steps)
        waves = plan.get_execution_order()
        
        try:
            for wave in waves:
                # Check for shutdown request
                if self._shutdown_requested:
                    raise ExecutionAborted("Shutdown requested")
                
                # Get pending steps in this wave
                pending = [
                    step_id for step_id in wave
                    if self._is_step_pending(execution, step_id)
                ]
                
                if not pending:
                    continue
                
                # Update current step IDs
                execution.current_step_ids = pending
                execution.overall_status = "running"
                
                # Execute wave in parallel
                await self._execute_wave(plan, execution, pending)
                
                self._wave_count += 1
                
                # Save checkpoint based on strategy frequency
                if self._checkpoint_manager and self._wave_count % self._checkpoint_frequency == 0:
                    try:
                        execution.checkpoint_path = self._checkpoint_manager.save(execution)
                    except DiskFullError as e:
                        self._show_error(f"⚠️ {e}")
                        # Continue without checkpoint - best effort
            
            # Mark complete
            execution.overall_status = self._determine_final_status(execution)
            execution.completed_at = datetime.now()
            execution.current_step_ids = []
            
        except ExecutionAborted:
            execution.overall_status = "failed"
            raise
        except Exception as e:
            execution.overall_status = "failed"
            self._show_error(f"Execution failed: {e}")
            raise
        finally:
            self._current_execution = None
        
        return execution
    
    def _initialize_execution(
        self,
        plan: Plan,
        resume: bool,
        fresh: bool,
    ) -> PlanExecution:
        """Initialize or restore execution state."""
        if fresh:
            return plan.to_execution()
        
        if resume and self._checkpoint_manager:
            try:
                checkpoint = self._checkpoint_manager.load(plan.id)
                if checkpoint:
                    return checkpoint
            except CheckpointCorruptedError as e:
                # Try to recover
                recovered = self._checkpoint_manager.try_recover(plan.id)
                if recovered:
                    self._show_message(
                        f"[yellow]⚠️ Recovered from corrupted checkpoint: {e}[/yellow]"
                    )
                    return recovered
                self._show_error(f"Checkpoint corrupted and unrecoverable: {e}")
        
        # Check for existing checkpoint (smart resume)
        if self._checkpoint_manager and self._checkpoint_manager.should_resume(plan.id):
            try:
                checkpoint = self._checkpoint_manager.load(plan.id)
                if checkpoint:
                    return checkpoint
            except CheckpointCorruptedError:
                recovered = self._checkpoint_manager.try_recover(plan.id)
                if recovered:
                    return recovered
        
        return plan.to_execution()
    
    def _is_step_pending(self, execution: PlanExecution, step_id: str) -> bool:
        """Check if step is pending (not completed, failed, or skipped)."""
        for step in execution.steps:
            if step.step_id == step_id:
                return step.status in ("pending", "running")
        return True
    
    async def _execute_wave(
        self,
        plan: Plan,
        execution: PlanExecution,
        step_ids: list[str],
    ):
        """Execute a wave of steps in parallel."""
        # Get max parallel from strategy or override
        max_parallel = self._max_parallel_override
        if max_parallel is None and self._strategy:
            max_parallel = self._strategy.get_max_parallel(len(plan.steps))
        else:
            max_parallel = max_parallel or 3  # Default
        
        # Limit parallelism with semaphore
        semaphore = asyncio.Semaphore(max_parallel)
        
        async def run_with_limit(step_id: str):
            async with semaphore:
                return await self._execute_step_with_recovery(plan, execution, step_id)
        
        # Run all steps concurrently
        tasks = [run_with_limit(sid) for sid in step_ids]
        await asyncio.gather(*tasks, return_exceptions=True)
    
    async def _execute_step_with_recovery(
        self,
        plan: Plan,
        execution: PlanExecution,
        step_id: str,
    ) -> StepExecution:
        """Execute step with resilient error handling and retries.
        
        Handles:
        - LLM timeout errors with exponential backoff
        - Rate limiting with fixed wait
        - Network errors with retry
        - General LLM errors
        """
        step = plan.get_step(step_id)
        if not step:
            raise StepExecutionError(f"Step not found: {step_id}", step_id)
        
        step_exec = self._get_or_create_step_execution(execution, step_id)
        
        # Get retry policy from strategy
        retry_policy = self._strategy.get_retry_policy() if self._strategy else {
            "max_retries": 3, "base_delay": 2.0, "max_delay": 16.0
        }
        max_retries = retry_policy["max_retries"]
        base_delay = retry_policy["base_delay"]
        max_delay = retry_policy["max_delay"]
        
        for attempt in range(max_retries + 1):
            try:
                return await self._execute_step(plan, execution, step_id)
                
            except LLMTimeoutError as e:
                if attempt < max_retries:
                    delay = min(base_delay * (2 ** attempt), max_delay)
                    self._show_retry_message(
                        f"Step {step_id}: LLM timeout, retrying in {delay:.1f}s... (attempt {attempt + 1}/{max_retries})"
                    )
                    self._notify_retry(step_id, attempt + 1, f"timeout: {e}")
                    await asyncio.sleep(delay)
                    continue
                step_exec.error_message = f"LLM timeout after {max_retries} retries"
                raise
                
            except LLMRateLimitError as e:
                wait_time = e.retry_after
                self._show_retry_message(
                    f"Step {step_id}: Rate limited, waiting {wait_time}s..."
                )
                self._notify_retry(step_id, attempt + 1, f"rate_limit: wait {wait_time}s")
                await asyncio.sleep(wait_time)
                # Don't count rate limit against retries
                continue
                
            except LLMError as e:
                step_exec.error_message = f"LLM error: {e}"
                self._show_error(f"Step {step_id}: LLM error: {e}")
                raise
                
            except NetworkError as e:
                if attempt < max_retries:
                    delay = min(5 * (attempt + 1), max_delay)
                    self._show_retry_message(
                        f"Step {step_id}: Network error, retrying in {delay:.1f}s... (attempt {attempt + 1}/{max_retries})"
                    )
                    self._notify_retry(step_id, attempt + 1, f"network: {e}")
                    await asyncio.sleep(delay)
                    continue
                step_exec.error_message = f"Network error after {max_retries} retries: {e}"
                raise
                
            except ExecutionAborted:
                raise
                
            except Exception as e:
                # Unknown error - treat as step failure
                step_exec.error_message = f"Unexpected error: {e}"
                self._show_error(f"Step {step_id}: Unexpected error: {e}")
                raise StepExecutionError(str(e), step_id)
        
        return step_exec
    
    async def _execute_step(
        self,
        plan: Plan,
        execution: PlanExecution,
        step_id: str,
    ) -> StepExecution:
        """Execute single step."""
        step = plan.get_step(step_id)
        if not step:
            raise ValueError(f"Step not found: {step_id}")
        
        step_exec = self._get_or_create_step_execution(execution, step_id)
        
        # Notify start
        step_exec.status = "running"
        step_exec.started_at = datetime.now()
        self._notify("step_start", step_exec)
        
        # Get completed steps for context
        completed_steps = self._get_completed_steps_context(execution)
        
        # Retry loop (internal step-level retries for non-LLM errors)
        for attempt in range(step_exec.max_retries + 1):
            try:
                # Check for shutdown request
                if self._shutdown_requested:
                    raise ExecutionAborted("Shutdown requested during step execution")
                
                # Execute step via LLM
                result = await self._step_runner.run(
                    step=step,
                    plan_description=plan.query,
                    completed_steps=completed_steps,
                )
                
                # Success
                step_exec.status = "completed"
                step_exec.completed_at = datetime.now()
                step_exec.duration_seconds = (
                    step_exec.completed_at - step_exec.started_at
                ).total_seconds()
                step_exec.output_summary = result.get("summary", "")
                step_exec.files_modified = result.get("files", [])
                step_exec.lines_added = result.get("lines_added", 0)
                step_exec.lines_removed = result.get("lines_removed", 0)
                
                self._notify("step_complete", step_exec)
                return step_exec
                
            except Exception as e:
                step_exec.retry_count += 1
                step_exec.error_message = str(e)
                
                if step_exec.retry_count <= step_exec.max_retries:
                    # Exponential backoff
                    delay = 2 ** step_exec.retry_count
                    await asyncio.sleep(delay)
                    continue
                else:
                    # Max retries exceeded
                    step_exec.status = "failed"
                    self._notify("step_failed", step_exec)
                    
                    # Ask user for decision
                    decision = await self._ask_user_on_failure(step_exec)
                    
                    if decision == "retry":
                        step_exec.retry_count = 0
                        step_exec.error_message = None
                        continue
                    elif decision == "skip":
                        step_exec.status = "skipped"
                        return step_exec
                    else:  # abort
                        raise ExecutionAborted(f"Step {step_id} failed")
        
        return step_exec
    
    def _get_or_create_step_execution(
        self,
        execution: PlanExecution,
        step_id: str,
    ) -> StepExecution:
        """Get existing or create new StepExecution."""
        for step in execution.steps:
            if step.step_id == step_id:
                return step
        
        # Create new
        step_exec = StepExecution(
            step_id=step_id,
            status="pending",
            max_retries=3,
        )
        execution.steps.append(step_exec)
        return step_exec
    
    def _get_completed_steps_context(self, execution: PlanExecution) -> list[dict]:
        """Get summaries of completed steps for context."""
        return [
            {
                "id": step.step_id,
                "name": step.step_id,
                "summary": step.output_summary,
            }
            for step in execution.steps
            if step.status == "completed"
        ]
    
    def _notify(self, event: str, step_exec: StepExecution):
        """Notify all listeners of event."""
        listeners = {
            "step_start": self._on_step_start,
            "step_complete": self._on_step_complete,
            "step_failed": self._on_step_failed,
        }.get(event, [])
        
        for listener in listeners:
            try:
                listener(step_exec)
            except Exception:
                pass  # Don't let listeners break execution
    
    def _notify_retry(self, step_id: str, attempt: int, reason: str):
        """Notify retry listeners."""
        for listener in self._on_retry:
            try:
                listener(step_id, attempt, reason)
            except Exception:
                pass
    
    async def _ask_user_on_failure(self, step_exec: StepExecution) -> str:
        """Ask user what to do on step failure.
        
        Returns: "retry" | "skip" | "abort"
        """
        # For now, simple console input
        # In real implementation, use rich prompts
        from kimi_cli.soul import wire_send
        from kimi_cli.wire.types import TextPart
        
        message = f"""
Step {step_exec.step_id} failed after {step_exec.retry_count} retries.

Error: {step_exec.error_message[:200]}

What would you like to do?
[r]etry - Retry the step
[s]kip  - Skip this step and continue
[a]bort - Abort plan execution

Choice: """
        
        wire_send(TextPart(text=message))
        
        # TODO: Implement proper async user input
        # For now, default to abort
        return "abort"
    
    def _determine_final_status(
        self,
        execution: PlanExecution,
    ) -> str:
        """Determine overall execution status."""
        has_failed = any(s.status == "failed" for s in execution.steps)
        has_skipped = any(s.status == "skipped" for s in execution.steps)
        all_completed = all(s.status == "completed" for s in execution.steps)
        
        if all_completed:
            return "completed"
        elif has_failed:
            return "failed"
        elif has_skipped:
            return "partial"
        return "completed"
    
    def generate_error_report(self, execution: PlanExecution) -> str:
        """Generate detailed error report for failed execution.
        
        Args:
            execution: Failed execution
            
        Returns:
            Formatted error report as string
        """
        lines = ["# Execution Error Report", ""]
        
        lines.append(f"Plan ID: {execution.plan_id}")
        lines.append(f"Overall Status: {execution.overall_status}")
        lines.append(f"Started: {execution.started_at}")
        lines.append(f"Completed: {execution.completed_at or 'N/A'}")
        
        # Add strategy info if available
        if self._strategy:
            lines.append(f"Strategy: {get_strategy_name(self._strategy)}")
        
        lines.append("")
        
        # Failed steps
        failed_steps = [s for s in execution.steps if s.status == "failed"]
        if failed_steps:
            lines.append("## Failed Steps")
            for step in failed_steps:
                lines.append(f"- Step {step.step_number}: {step.step_id}")
                if step.error_message:
                    error = step.error_message[:200]
                    if len(step.error_message) > 200:
                        error += "..."
                    lines.append(f"  Error: {error}")
                lines.append(f"  Retries: {step.retry_count}")
                lines.append("")
        
        # Summary stats
        completed = sum(1 for s in execution.steps if s.status == "completed")
        skipped = sum(1 for s in execution.steps if s.status == "skipped")
        total = len(execution.steps)
        
        lines.append("## Summary")
        lines.append(f"- Completed: {completed}/{total}")
        lines.append(f"- Failed: {len(failed_steps)}/{total}")
        lines.append(f"- Skipped: {skipped}/{total}")
        lines.append("")
        
        lines.append("## Recommendations")
        if failed_steps:
            lines.append("- Check LLM connectivity and API status")
            lines.append("- Verify rate limits haven't been exceeded")
        lines.append("- Check disk space for checkpoints")
        lines.append("- Resume with /plan-execute --resume")
        
        return "\n".join(lines)
    
    def get_stats(self, execution: PlanExecution) -> dict:
        """Get execution statistics.
        
        Args:
            execution: Execution to analyze
            
        Returns:
            Dict with execution statistics
        """
        completed = [s for s in execution.steps if s.status == "completed"]
        failed = [s for s in execution.steps if s.status == "failed"]
        skipped = [s for s in execution.steps if s.status == "skipped"]
        pending = [s for s in execution.steps if s.status in ("pending", "running")]
        
        total_duration = sum(s.duration_seconds or 0 for s in completed)
        total_retries = sum(s.retry_count for s in execution.steps)
        
        return {
            "total_steps": len(execution.steps),
            "completed": len(completed),
            "failed": len(failed),
            "skipped": len(skipped),
            "pending": len(pending),
            "total_duration_seconds": total_duration,
            "total_retries": total_retries,
            "average_step_duration": total_duration / len(completed) if completed else 0,
            "strategy": get_strategy_name(self._strategy) if self._strategy else None,
        }


# Backward compatibility: Keep ExecutionAborted exported from executor
# (now also in errors.py)
ExecutionAborted = ExecutionAborted

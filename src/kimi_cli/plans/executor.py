"""
Plan execution engine with parallel execution, retries, and checkpoints.

This module provides the main PlanExecutor class that orchestrates plan execution,
including parallel step execution, automatic retries with exponential backoff,
checkpoint management for resumability, and user interaction on failures.
"""

import asyncio
from datetime import datetime
from typing import Callable

from kimi_cli.plans.models import Plan, PlanStep, PlanExecution, StepExecution
from kimi_cli.plans.checkpoint import CheckpointManager
from kimi_cli.plans.step_runner import StepRunner


class ExecutionAborted(Exception):
    """Raised when user aborts execution."""
    pass


class PlanExecutor:
    """Execute plans with parallel steps, retries, and checkpoints."""
    
    def __init__(
        self,
        llm,
        max_parallel: int = 3,
        enable_checkpoints: bool = True,
    ):
        self._llm = llm
        self._max_parallel = max_parallel
        self._enable_checkpoints = enable_checkpoints
        self._checkpoint_manager = CheckpointManager() if enable_checkpoints else None
        self._step_runner = StepRunner(llm)
        
        # Event listeners
        self._on_step_start: list[Callable[[StepExecution], None]] = []
        self._on_step_complete: list[Callable[[StepExecution], None]] = []
        self._on_step_failed: list[Callable[[StepExecution], None]] = []
    
    def add_listener(self, event: str, callback: Callable[[StepExecution], None]):
        """Add event listener.
        
        Events: "step_start", "step_complete", "step_failed"
        """
        if event == "step_start":
            self._on_step_start.append(callback)
        elif event == "step_complete":
            self._on_step_complete.append(callback)
        elif event == "step_failed":
            self._on_step_failed.append(callback)
    
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
        # Determine start state
        execution = self._initialize_execution(plan, resume, fresh)
        
        # Get execution order (waves of parallel steps)
        waves = plan.get_execution_order()
        
        try:
            for wave in waves:
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
                
                # Save checkpoint after wave
                if self._checkpoint_manager:
                    execution.checkpoint_path = self._checkpoint_manager.save(execution)
            
            # Mark complete
            execution.overall_status = self._determine_final_status(execution)
            execution.completed_at = datetime.now()
            execution.current_step_ids = []
            
        except ExecutionAborted:
            execution.overall_status = "failed"
            raise
        
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
            checkpoint = self._checkpoint_manager.load(plan.id)
            if checkpoint:
                return checkpoint
        
        # Check for existing checkpoint (smart resume)
        if self._checkpoint_manager and self._checkpoint_manager.should_resume(plan.id):
            checkpoint = self._checkpoint_manager.load(plan.id)
            if checkpoint:
                return checkpoint
        
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
        # Limit parallelism with semaphore
        semaphore = asyncio.Semaphore(self._max_parallel)
        
        async def run_with_limit(step_id: str):
            async with semaphore:
                return await self._execute_step(plan, execution, step_id)
        
        # Run all steps concurrently
        tasks = [run_with_limit(sid) for sid in step_ids]
        await asyncio.gather(*tasks, return_exceptions=True)
    
    async def _execute_step(
        self,
        plan: Plan,
        execution: PlanExecution,
        step_id: str,
    ) -> StepExecution:
        """Execute single step with retries."""
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
        
        # Retry loop
        for attempt in range(step_exec.max_retries + 1):
            try:
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
                "name": step.step_id,  # TODO: Get actual name
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

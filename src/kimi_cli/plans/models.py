"""
Data models for the kimi-cli Plans System.

This module defines the core data structures for plan generation,
storage, and execution tracking.
"""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal, Optional


@dataclass
class PlanOption:
    """
    Represents a single plan option with trade-offs and estimates.
    
    Attributes:
        id: Numeric identifier (1, 2, or 3)
        title: Short descriptive name for the option
        description: Detailed explanation of the approach
        pros: List of advantages for this option
        cons: List of disadvantages for this option
        estimated_time: Time estimate (e.g., "5 min", "30 min", "2 hours") or None
        approach_type: Classification of the approach type
    """
    id: int
    title: str
    description: str
    pros: list[str]
    cons: list[str]
    estimated_time: Optional[str]
    approach_type: Literal["quick", "proper", "hybrid"]


@dataclass
class PlanStep:
    """Individual step in a plan with execution metadata."""
    id: str  # Unique step ID (e.g., "step_1", "step_2a")
    name: str  # Short name
    description: str  # Detailed description
    depends_on: list[str] = field(default_factory=list)  # IDs of steps that must complete first
    can_parallel: bool = True  # Can run in parallel with others
    estimated_duration: Optional[str] = None  # "5 min", "30 min"


@dataclass
class StepExecution:
    """Execution state for a single step."""
    step_id: str
    status: Literal["pending", "running", "completed", "failed", "skipped"]
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    duration_seconds: float = 0.0
    retry_count: int = 0
    max_retries: int = 3
    error_message: Optional[str] = None
    files_modified: list[str] = field(default_factory=list)
    lines_added: int = 0
    lines_removed: int = 0
    output_summary: str = ""  # Brief description of what was done


@dataclass
class Plan:
    """
    Represents a plan with multiple options for a user request.
    
    Attributes:
        id: Unique identifier (UUID or timestamp-based)
        query: Original user request/query
        options: List of 2-3 plan options to choose from
        created_at: Timestamp when the plan was created
        context_snapshot: Relevant context at the time of plan creation
        steps: High-level steps for execution
    """
    id: str
    query: str
    options: list[PlanOption]
    created_at: datetime
    context_snapshot: dict
    steps: list[PlanStep] = field(default_factory=list)  # High-level steps for execution
    
    def get_execution_order(self) -> list[list[str]]:
        """Return steps grouped by execution wave (parallel groups).
        
        Uses topological sort to group steps by dependency level.
        Steps in the same wave can run in parallel.
        
        Returns:
            List of waves, where each wave is a list of step IDs
            Example: [["s1"], ["s2", "s3"], ["s4"]]
        """
        # Build step lookup and dependency tracking
        step_map = {step.id: step for step in self.steps}
        
        # Track completed steps (those whose dependencies are satisfied)
        completed = set()
        remaining = set(step.id for step in self.steps)
        waves = []
        
        while remaining:
            # Find all steps that can run now (all dependencies satisfied)
            current_wave = []
            for step_id in list(remaining):
                step = step_map[step_id]
                if all(dep in completed for dep in step.depends_on):
                    current_wave.append(step_id)
            
            if not current_wave:
                # Circular dependency detected - break to avoid infinite loop
                # Add remaining steps as a final wave
                if remaining:
                    waves.append(list(remaining))
                break
            
            waves.append(current_wave)
            completed.update(current_wave)
            remaining.difference_update(current_wave)
        
        return waves
    
    def get_step(self, step_id: str) -> Optional[PlanStep]:
        """Get step by ID."""
        for step in self.steps:
            if step.id == step_id:
                return step
        return None
    
    def to_execution(self) -> "PlanExecution":
        """Create initial execution state from plan."""
        return PlanExecution(
            plan_id=self.id,
            started_at=datetime.now(),
            steps=[
                StepExecution(
                    step_id=step.id,
                    status="pending",
                    max_retries=3,
                )
                for step in self.steps
            ]
        )


@dataclass
class PlanExecution:
    """Full execution state for a plan."""
    plan_id: str
    started_at: datetime
    completed_at: Optional[datetime] = None
    steps: list[StepExecution] = field(default_factory=list)
    overall_status: Literal["running", "completed", "failed", "partial"] = "running"
    current_step_ids: list[str] = field(default_factory=list)
    checkpoint_path: Optional[Path] = None
    
    def get_progress(self) -> tuple[int, int]:
        """Return (completed_steps, total_steps)."""
        completed = sum(1 for s in self.steps if s.status == "completed")
        return completed, len(self.steps)
    
    def get_duration(self) -> float:
        """Return total duration in seconds."""
        if self.completed_at:
            return (self.completed_at - self.started_at).total_seconds()
        return (datetime.now() - self.started_at).total_seconds()


@dataclass
class LegacyPlanExecution:
    """
    Tracks the execution of a selected plan option.
    
    Attributes:
        plan_id: Reference to the executed plan
        selected_option: The option ID that was chosen (1, 2, or 3)
        executed_at: Timestamp when execution started
        status: Current execution status
    """
    plan_id: str
    selected_option: int
    executed_at: datetime
    status: Literal["pending", "completed", "failed"]

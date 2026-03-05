"""Tests for plans.models module."""

import pytest
from datetime import datetime

from kimi_cli.plans.models import (
    Plan,
    PlanOption,
    PlanStep,
    PlanExecution,
    StepExecution,
    LegacyPlanExecution,
)


class TestPlanOption:
    """Tests for PlanOption dataclass."""

    def test_create_plan_option(self):
        """Test creating a PlanOption with valid data."""
        option = PlanOption(
            id=1,
            title="Test Option",
            description="A test option",
            pros=["Fast", "Simple"],
            cons=["Technical debt"],
            estimated_time="30 min",
            approach_type="quick",
        )
        
        assert option.id == 1
        assert option.title == "Test Option"
        assert option.description == "A test option"
        assert option.pros == ["Fast", "Simple"]
        assert option.cons == ["Technical debt"]
        assert option.estimated_time == "30 min"
        assert option.approach_type == "quick"

    def test_plan_option_with_none_time(self):
        """Test PlanOption with None estimated_time."""
        option = PlanOption(
            id=2,
            title="Unknown Time",
            description="Option with unknown time",
            pros=[],
            cons=[],
            estimated_time=None,
            approach_type="hybrid",
        )
        
        assert option.estimated_time is None

    def test_plan_option_approach_types(self):
        """Test all valid approach types."""
        for approach in ["quick", "proper", "hybrid"]:
            option = PlanOption(
                id=1,
                title="Test",
                description="Test",
                pros=[],
                cons=[],
                estimated_time=None,
                approach_type=approach,
            )
            assert option.approach_type == approach


class TestPlanStep:
    """Tests for PlanStep dataclass."""

    def test_create_plan_step(self):
        """Test creating a PlanStep."""
        step = PlanStep(
            id="step_1",
            name="Setup",
            description="Initial setup",
            depends_on=[],
            can_parallel=True,
            estimated_duration="5 min",
        )
        
        assert step.id == "step_1"
        assert step.name == "Setup"
        assert step.description == "Initial setup"
        assert step.depends_on == []
        assert step.can_parallel is True
        assert step.estimated_duration == "5 min"

    def test_plan_step_with_dependencies(self):
        """Test PlanStep with dependencies."""
        step = PlanStep(
            id="step_2",
            name="Build",
            description="Build step",
            depends_on=["step_1", "step_0"],
            can_parallel=False,
            estimated_duration=None,
        )
        
        assert step.depends_on == ["step_1", "step_0"]
        assert step.can_parallel is False
        assert step.estimated_duration is None

    def test_plan_step_default_values(self):
        """Test PlanStep default values."""
        step = PlanStep(
            id="step_1",
            name="Test",
            description="Test step",
        )
        
        assert step.depends_on == []
        assert step.can_parallel is True
        assert step.estimated_duration is None


class TestStepExecution:
    """Tests for StepExecution dataclass."""

    def test_create_step_execution(self):
        """Test creating a StepExecution."""
        step_exec = StepExecution(
            step_id="step_1",
            status="pending",
        )
        
        assert step_exec.step_id == "step_1"
        assert step_exec.status == "pending"
        assert step_exec.started_at is None
        assert step_exec.completed_at is None
        assert step_exec.duration_seconds == 0.0
        assert step_exec.retry_count == 0
        assert step_exec.max_retries == 3
        assert step_exec.error_message is None
        assert step_exec.files_modified == []
        assert step_exec.lines_added == 0
        assert step_exec.lines_removed == 0
        assert step_exec.output_summary == ""

    def test_step_execution_status_transitions(self):
        """Test StepExecution status field accepts all valid statuses."""
        for status in ["pending", "running", "completed", "failed", "skipped"]:
            step_exec = StepExecution(
                step_id="step_1",
                status=status,
            )
            assert step_exec.status == status

    def test_step_execution_with_timestamps(self):
        """Test StepExecution with timestamps."""
        started = datetime(2024, 3, 4, 12, 0, 0)
        completed = datetime(2024, 3, 4, 12, 5, 0)
        
        step_exec = StepExecution(
            step_id="step_1",
            status="completed",
            started_at=started,
            completed_at=completed,
            duration_seconds=300.0,
            retry_count=1,
            max_retries=5,
            error_message=None,
            files_modified=["file.py"],
            lines_added=10,
            lines_removed=2,
            output_summary="Added feature",
        )
        
        assert step_exec.started_at == started
        assert step_exec.completed_at == completed
        assert step_exec.duration_seconds == 300.0
        assert step_exec.retry_count == 1
        assert step_exec.max_retries == 5
        assert step_exec.files_modified == ["file.py"]
        assert step_exec.lines_added == 10
        assert step_exec.lines_removed == 2
        assert step_exec.output_summary == "Added feature"


class TestPlan:
    """Tests for Plan dataclass."""

    def test_create_plan(self, sample_plan_options):
        """Test creating a Plan."""
        created_at = datetime(2024, 3, 4, 12, 0, 0)
        plan = Plan(
            id="plan-123",
            query="Test query",
            options=sample_plan_options,
            created_at=created_at,
            context_snapshot={"key": "value"},
            steps=[],
        )
        
        assert plan.id == "plan-123"
        assert plan.query == "Test query"
        assert len(plan.options) == 3
        assert plan.created_at == created_at
        assert plan.context_snapshot == {"key": "value"}
        assert plan.steps == []

    def test_get_step_existing(self, sample_plan_steps):
        """Test get_step returns existing step."""
        plan = Plan(
            id="plan-1",
            query="Test",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
            steps=sample_plan_steps,
        )
        
        step = plan.get_step("step_2")
        assert step is not None
        assert step.name == "Design"
        assert step.description == "Design the solution"

    def test_get_step_nonexistent(self):
        """Test get_step returns None for non-existent step."""
        plan = Plan(
            id="plan-1",
            query="Test",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
            steps=[],
        )
        
        step = plan.get_step("nonexistent")
        assert step is None

    def test_get_execution_order_simple(self):
        """Test get_execution_order with simple linear dependencies."""
        steps = [
            PlanStep(id="a", name="A", description="Step A", depends_on=[]),
            PlanStep(id="b", name="B", description="Step B", depends_on=["a"]),
            PlanStep(id="c", name="C", description="Step C", depends_on=["b"]),
        ]
        
        plan = Plan(
            id="plan-1",
            query="Test",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
            steps=steps,
        )
        
        waves = plan.get_execution_order()
        assert waves == [["a"], ["b"], ["c"]]

    def test_get_execution_order_parallel(self):
        """Test get_execution_order with parallelizable steps."""
        steps = [
            PlanStep(id="a", name="A", description="Step A", depends_on=[]),
            PlanStep(id="b", name="B", description="Step B", depends_on=["a"]),
            PlanStep(id="c", name="C", description="Step C", depends_on=["a"]),
            PlanStep(id="d", name="D", description="Step D", depends_on=["b", "c"]),
        ]
        
        plan = Plan(
            id="plan-1",
            query="Test",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
            steps=steps,
        )
        
        waves = plan.get_execution_order()
        assert len(waves) == 3
        assert waves[0] == ["a"]  # First wave always "a"
        assert set(waves[1]) == {"b", "c"}  # Second wave can be any order
        assert waves[2] == ["d"]  # Third wave always "d"

    def test_get_execution_order_no_dependencies(self):
        """Test get_execution_order with no dependencies."""
        steps = [
            PlanStep(id="a", name="A", description="Step A", depends_on=[]),
            PlanStep(id="b", name="B", description="Step B", depends_on=[]),
            PlanStep(id="c", name="C", description="Step C", depends_on=[]),
        ]
        
        plan = Plan(
            id="plan-1",
            query="Test",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
            steps=steps,
        )
        
        waves = plan.get_execution_order()
        # Order may vary since sets are used, but all steps should be in one wave
        assert len(waves) == 1
        assert set(waves[0]) == {"a", "b", "c"}

    def test_get_execution_order_empty(self):
        """Test get_execution_order with no steps."""
        plan = Plan(
            id="plan-1",
            query="Test",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
            steps=[],
        )
        
        waves = plan.get_execution_order()
        assert waves == []

    def test_get_execution_order_circular_dependency(self):
        """Test get_execution_order handles circular dependencies."""
        steps = [
            PlanStep(id="a", name="A", description="Step A", depends_on=["c"]),
            PlanStep(id="b", name="B", description="Step B", depends_on=["a"]),
            PlanStep(id="c", name="C", description="Step C", depends_on=["b"]),
        ]
        
        plan = Plan(
            id="plan-1",
            query="Test",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
            steps=steps,
        )
        
        waves = plan.get_execution_order()
        # Should handle gracefully, not infinite loop
        # The remaining steps should be added as a final wave
        assert len(waves) > 0
        # All steps should appear in waves
        all_steps = set()
        for wave in waves:
            all_steps.update(wave)
        assert all_steps == {"a", "b", "c"}

    def test_to_execution(self, sample_plan_options, sample_plan_steps):
        """Test to_execution creates valid PlanExecution."""
        plan = Plan(
            id="plan-123",
            query="Test query",
            options=sample_plan_options,
            created_at=datetime.now(),
            context_snapshot={},
            steps=sample_plan_steps,
        )
        
        execution = plan.to_execution()
        
        assert execution.plan_id == "plan-123"
        assert execution.overall_status == "running"
        assert execution.completed_at is None
        assert len(execution.steps) == 5
        
        # Check all steps are pending
        for step_exec in execution.steps:
            assert step_exec.status == "pending"
            assert step_exec.max_retries == 3

    def test_to_execution_empty_steps(self, sample_plan_options):
        """Test to_execution with empty steps."""
        plan = Plan(
            id="plan-123",
            query="Test query",
            options=sample_plan_options,
            created_at=datetime.now(),
            context_snapshot={},
            steps=[],
        )
        
        execution = plan.to_execution()
        
        assert execution.plan_id == "plan-123"
        assert execution.steps == []


class TestPlanExecution:
    """Tests for PlanExecution dataclass."""

    def test_create_plan_execution(self):
        """Test creating a PlanExecution."""
        started_at = datetime(2024, 3, 4, 12, 0, 0)
        
        execution = PlanExecution(
            plan_id="plan-123",
            started_at=started_at,
            completed_at=None,
            steps=[],
            overall_status="running",
            current_step_ids=[],
            checkpoint_path=None,
        )
        
        assert execution.plan_id == "plan-123"
        assert execution.started_at == started_at
        assert execution.completed_at is None
        assert execution.steps == []
        assert execution.overall_status == "running"
        assert execution.current_step_ids == []
        assert execution.checkpoint_path is None

    def test_get_progress_empty(self):
        """Test get_progress with no steps."""
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[],
        )
        
        completed, total = execution.get_progress()
        assert completed == 0
        assert total == 0

    def test_get_progress_all_pending(self, sample_step_execution):
        """Test get_progress with all pending steps."""
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[
                sample_step_execution,
                StepExecution(step_id="step_2", status="pending"),
            ],
        )
        
        completed, total = execution.get_progress()
        assert completed == 0
        assert total == 2

    def test_get_progress_mixed_status(self):
        """Test get_progress with mixed step statuses."""
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[
                StepExecution(step_id="step_1", status="completed"),
                StepExecution(step_id="step_2", status="failed"),
                StepExecution(step_id="step_3", status="completed"),
                StepExecution(step_id="step_4", status="pending"),
            ],
        )
        
        completed, total = execution.get_progress()
        assert completed == 2
        assert total == 4

    def test_get_duration_running(self):
        """Test get_duration for running execution."""
        started_at = datetime(2024, 3, 4, 12, 0, 0)
        
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=started_at,
            completed_at=None,
        )
        
        # Duration should be positive (time elapsed since start)
        duration = execution.get_duration()
        assert duration > 0

    def test_get_duration_completed(self):
        """Test get_duration for completed execution."""
        started_at = datetime(2024, 3, 4, 12, 0, 0)
        completed_at = datetime(2024, 3, 4, 12, 5, 30)
        
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=started_at,
            completed_at=completed_at,
        )
        
        duration = execution.get_duration()
        assert duration == 330.0  # 5 minutes 30 seconds


class TestLegacyPlanExecution:
    """Tests for LegacyPlanExecution dataclass."""

    def test_create_legacy_execution(self):
        """Test creating a LegacyPlanExecution."""
        executed_at = datetime(2024, 3, 4, 12, 0, 0)
        
        execution = LegacyPlanExecution(
            plan_id="plan-123",
            selected_option=2,
            executed_at=executed_at,
            status="completed",
        )
        
        assert execution.plan_id == "plan-123"
        assert execution.selected_option == 2
        assert execution.executed_at == executed_at
        assert execution.status == "completed"

    def test_legacy_execution_status_values(self):
        """Test all valid status values for LegacyPlanExecution."""
        for status in ["pending", "completed", "failed"]:
            execution = LegacyPlanExecution(
                plan_id="plan-1",
                selected_option=1,
                executed_at=datetime.now(),
                status=status,
            )
            assert execution.status == status

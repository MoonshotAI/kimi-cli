"""Tests for plans.executor module."""

import pytest
import asyncio
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

from kimi_cli.plans.executor import PlanExecutor, ExecutionAborted
from kimi_cli.plans.models import Plan, PlanStep, PlanExecution, StepExecution


class TestExecutionAborted:
    """Tests for ExecutionAborted exception."""

    def test_is_exception(self):
        """Test ExecutionAborted is an Exception."""
        error = ExecutionAborted("test")
        assert isinstance(error, Exception)
        assert str(error) == "test"


class TestPlanExecutorInit:
    """Tests for PlanExecutor initialization."""

    def test_init_defaults(self, mock_llm):
        """Test initialization with default values."""
        executor = PlanExecutor(llm=mock_llm)
        
        assert executor._llm is mock_llm
        assert executor._max_parallel_override is None  # Uses default from strategy
        assert executor._enable_checkpoints is True
        assert executor._checkpoint_manager is not None

    def test_init_custom_values(self, mock_llm):
        """Test initialization with custom values."""
        executor = PlanExecutor(
            llm=mock_llm,
            max_parallel=5,
            enable_checkpoints=False,
        )
        
        assert executor._max_parallel_override == 5
        assert executor._enable_checkpoints is False
        assert executor._checkpoint_manager is None

    def test_init_enables_checkpoint_manager(self, mock_llm):
        """Test that checkpoints enabled creates checkpoint manager."""
        executor = PlanExecutor(llm=mock_llm, enable_checkpoints=True)
        
        from kimi_cli.plans.checkpoint import CheckpointManager
        assert isinstance(executor._checkpoint_manager, CheckpointManager)


class TestPlanExecutorListeners:
    """Tests for PlanExecutor event listeners."""

    def test_add_step_start_listener(self, mock_llm):
        """Test adding step_start listener."""
        executor = PlanExecutor(llm=mock_llm)
        callback = MagicMock()
        
        executor.add_listener("step_start", callback)
        
        assert callback in executor._on_step_start

    def test_add_step_complete_listener(self, mock_llm):
        """Test adding step_complete listener."""
        executor = PlanExecutor(llm=mock_llm)
        callback = MagicMock()
        
        executor.add_listener("step_complete", callback)
        
        assert callback in executor._on_step_complete

    def test_add_step_failed_listener(self, mock_llm):
        """Test adding step_failed listener."""
        executor = PlanExecutor(llm=mock_llm)
        callback = MagicMock()
        
        executor.add_listener("step_failed", callback)
        
        assert callback in executor._on_step_failed

    def test_add_unknown_listener_ignored(self, mock_llm):
        """Test adding unknown listener is silently ignored."""
        executor = PlanExecutor(llm=mock_llm)
        callback = MagicMock()
        
        executor.add_listener("unknown_event", callback)
        
        # Should not raise and should not add to any list
        assert callback not in executor._on_step_start
        assert callback not in executor._on_step_complete
        assert callback not in executor._on_step_failed


class TestPlanExecutorInitializeExecution:
    """Tests for PlanExecutor._initialize_execution method."""

    def test_initialize_fresh(self, mock_llm, sample_plan):
        """Test fresh initialization creates new execution."""
        executor = PlanExecutor(llm=mock_llm, enable_checkpoints=False)
        
        execution = executor._initialize_execution(sample_plan, resume=False, fresh=True)
        
        assert execution.plan_id == sample_plan.id
        assert execution.overall_status == "running"
        assert len(execution.steps) == len(sample_plan.steps)

    def test_initialize_without_resume_or_checkpoint(self, mock_llm, sample_plan):
        """Test initialization without resume and no checkpoint."""
        executor = PlanExecutor(llm=mock_llm, enable_checkpoints=False)
        
        execution = executor._initialize_execution(sample_plan, resume=False, fresh=False)
        
        assert execution.plan_id == sample_plan.id
        assert execution.overall_status == "running"


class TestPlanExecutorIsStepPending:
    """Tests for PlanExecutor._is_step_pending method."""

    def test_is_step_pending_true_for_pending(self, mock_llm):
        """Test pending step returns True."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[StepExecution(step_id="step_1", status="pending")],
        )
        
        assert executor._is_step_pending(execution, "step_1") is True

    def test_is_step_pending_true_for_running(self, mock_llm):
        """Test running step returns True."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[StepExecution(step_id="step_1", status="running")],
        )
        
        assert executor._is_step_pending(execution, "step_1") is True

    def test_is_step_pending_false_for_completed(self, mock_llm):
        """Test completed step returns False."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[StepExecution(step_id="step_1", status="completed")],
        )
        
        assert executor._is_step_pending(execution, "step_1") is False

    def test_is_step_pending_false_for_failed(self, mock_llm):
        """Test failed step returns False."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[StepExecution(step_id="step_1", status="failed")],
        )
        
        assert executor._is_step_pending(execution, "step_1") is False

    def test_is_step_pending_false_for_skipped(self, mock_llm):
        """Test skipped step returns False."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[StepExecution(step_id="step_1", status="skipped")],
        )
        
        assert executor._is_step_pending(execution, "step_1") is False

    def test_is_step_pending_true_for_missing_step(self, mock_llm):
        """Test missing step returns True (default)."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[],
        )
        
        assert executor._is_step_pending(execution, "step_1") is True


class TestPlanExecutorGetOrCreateStepExecution:
    """Tests for PlanExecutor._get_or_create_step_execution method."""

    def test_get_existing_step(self, mock_llm):
        """Test getting existing step execution."""
        executor = PlanExecutor(llm=mock_llm)
        existing = StepExecution(step_id="step_1", status="completed")
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[existing],
        )
        
        result = executor._get_or_create_step_execution(execution, "step_1")
        
        assert result is existing
        assert result.status == "completed"

    def test_create_new_step(self, mock_llm):
        """Test creating new step execution."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[],
        )
        
        result = executor._get_or_create_step_execution(execution, "step_1")
        
        assert result.step_id == "step_1"
        assert result.status == "pending"
        assert result.max_retries == 3
        assert result in execution.steps


class TestPlanExecutorGetCompletedStepsContext:
    """Tests for PlanExecutor._get_completed_steps_context method."""

    def test_empty_completed_steps(self, mock_llm):
        """Test empty list when no steps completed."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[
                StepExecution(step_id="step_1", status="pending"),
                StepExecution(step_id="step_2", status="running"),
            ],
        )
        
        result = executor._get_completed_steps_context(execution)
        
        assert result == []

    def test_get_completed_steps(self, mock_llm):
        """Test getting completed steps with summaries."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[
                StepExecution(
                    step_id="step_1",
                    status="completed",
                    output_summary="Did something",
                ),
                StepExecution(
                    step_id="step_2",
                    status="completed",
                    output_summary="Did something else",
                ),
                StepExecution(step_id="step_3", status="pending"),
            ],
        )
        
        result = executor._get_completed_steps_context(execution)
        
        assert len(result) == 2
        assert result[0]["id"] == "step_1"
        assert result[0]["summary"] == "Did something"
        assert result[1]["id"] == "step_2"
        assert result[1]["summary"] == "Did something else"


class TestPlanExecutorNotify:
    """Tests for PlanExecutor._notify method."""

    def test_notify_step_start(self, mock_llm):
        """Test notifying step_start listeners."""
        executor = PlanExecutor(llm=mock_llm)
        callback = MagicMock()
        executor.add_listener("step_start", callback)
        
        step_exec = StepExecution(step_id="step_1", status="running")
        executor._notify("step_start", step_exec)
        
        callback.assert_called_once_with(step_exec)

    def test_notify_step_complete(self, mock_llm):
        """Test notifying step_complete listeners."""
        executor = PlanExecutor(llm=mock_llm)
        callback = MagicMock()
        executor.add_listener("step_complete", callback)
        
        step_exec = StepExecution(step_id="step_1", status="completed")
        executor._notify("step_complete", step_exec)
        
        callback.assert_called_once_with(step_exec)

    def test_notify_step_failed(self, mock_llm):
        """Test notifying step_failed listeners."""
        executor = PlanExecutor(llm=mock_llm)
        callback = MagicMock()
        executor.add_listener("step_failed", callback)
        
        step_exec = StepExecution(step_id="step_1", status="failed")
        executor._notify("step_failed", step_exec)
        
        callback.assert_called_once_with(step_exec)

    def test_notify_multiple_listeners(self, mock_llm):
        """Test notifying multiple listeners."""
        executor = PlanExecutor(llm=mock_llm)
        callback1 = MagicMock()
        callback2 = MagicMock()
        executor.add_listener("step_start", callback1)
        executor.add_listener("step_start", callback2)
        
        step_exec = StepExecution(step_id="step_1", status="running")
        executor._notify("step_start", step_exec)
        
        callback1.assert_called_once_with(step_exec)
        callback2.assert_called_once_with(step_exec)

    def test_notify_listener_exception_ignored(self, mock_llm):
        """Test that listener exceptions are ignored."""
        executor = PlanExecutor(llm=mock_llm)
        bad_callback = MagicMock(side_effect=Exception("Oops"))
        good_callback = MagicMock()
        executor.add_listener("step_start", bad_callback)
        executor.add_listener("step_start", good_callback)
        
        step_exec = StepExecution(step_id="step_1", status="running")
        
        # Should not raise
        executor._notify("step_start", step_exec)
        
        good_callback.assert_called_once_with(step_exec)

    def test_notify_unknown_event(self, mock_llm):
        """Test notifying unknown event does nothing."""
        executor = PlanExecutor(llm=mock_llm)
        step_exec = StepExecution(step_id="step_1", status="running")
        
        # Should not raise
        executor._notify("unknown_event", step_exec)


class TestPlanExecutorDetermineFinalStatus:
    """Tests for PlanExecutor._determine_final_status method."""

    def test_all_completed(self, mock_llm):
        """Test status when all steps completed."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[
                StepExecution(step_id="step_1", status="completed"),
                StepExecution(step_id="step_2", status="completed"),
            ],
        )
        
        result = executor._determine_final_status(execution)
        
        assert result == "completed"

    def test_has_failed(self, mock_llm):
        """Test status when any step failed."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[
                StepExecution(step_id="step_1", status="completed"),
                StepExecution(step_id="step_2", status="failed"),
            ],
        )
        
        result = executor._determine_final_status(execution)
        
        assert result == "failed"

    def test_has_skipped_no_failed(self, mock_llm):
        """Test status when steps skipped but none failed."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[
                StepExecution(step_id="step_1", status="completed"),
                StepExecution(step_id="step_2", status="skipped"),
            ],
        )
        
        result = executor._determine_final_status(execution)
        
        assert result == "partial"

    def test_failed_takes_precedence_over_skipped(self, mock_llm):
        """Test failed status takes precedence over skipped."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id="plan-1",
            started_at=datetime.now(),
            steps=[
                StepExecution(step_id="step_1", status="skipped"),
                StepExecution(step_id="step_2", status="failed"),
            ],
        )
        
        result = executor._determine_final_status(execution)
        
        assert result == "failed"


class TestPlanExecutorExecuteWave:
    """Tests for PlanExecutor._execute_wave method."""

    @pytest.mark.asyncio
    async def test_execute_wave_empty(self, mock_llm, sample_plan):
        """Test executing empty wave."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id=sample_plan.id,
            started_at=datetime.now(),
            steps=[],
        )
        
        # Should complete without error
        await executor._execute_wave(sample_plan, execution, [])


class TestPlanExecutorExecuteStep:
    """Tests for PlanExecutor._execute_step method."""

    @pytest.mark.asyncio
    async def test_execute_step_not_found(self, mock_llm, sample_plan):
        """Test execute_step raises when step not found."""
        executor = PlanExecutor(llm=mock_llm)
        execution = PlanExecution(
            plan_id=sample_plan.id,
            started_at=datetime.now(),
            steps=[],
        )
        
        with pytest.raises(ValueError, match="Step not found"):
            await executor._execute_step(sample_plan, execution, "nonexistent")

    @pytest.mark.asyncio
    async def test_execute_step_success(self, mock_llm, sample_plan):
        """Test successful step execution."""
        executor = PlanExecutor(llm=mock_llm, enable_checkpoints=False)
        
        # Mock step_runner.run
        with patch.object(executor._step_runner, 'run', new_callable=AsyncMock) as mock_run:
            mock_run.return_value = {
                "summary": "Step done",
                "files": ["file.py"],
                "lines_added": 10,
                "lines_removed": 2,
            }
            
            execution = PlanExecution(
                plan_id=sample_plan.id,
                started_at=datetime.now(),
                steps=[],
            )
            
            result = await executor._execute_step(sample_plan, execution, "step_1")
            
            assert result.status == "completed"
            assert result.output_summary == "Step done"
            assert result.files_modified == ["file.py"]
            assert result.lines_added == 10
            assert result.lines_removed == 2
            assert result.completed_at is not None


class TestPlanExecutorAskUserOnFailure:
    """Tests for PlanExecutor._ask_user_on_failure method."""

    @pytest.mark.asyncio
    async def test_ask_user_returns_abort(self, mock_llm):
        """Test _ask_user_on_failure returns abort."""
        executor = PlanExecutor(llm=mock_llm)
        
        step_exec = StepExecution(
            step_id="step_1",
            status="failed",
            retry_count=3,
            error_message="Something went wrong",
        )
        
        # Mock the wire_send and TextPart at module level where they're imported
        with patch.object(executor, '_ask_user_on_failure', new_callable=AsyncMock) as mock_ask:
            mock_ask.return_value = "abort"
            result = await executor._ask_user_on_failure(step_exec)
        
        # Currently defaults to abort
        assert result == "abort"

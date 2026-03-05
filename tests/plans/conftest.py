"""Fixtures for plans module tests."""

import pytest
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

from kimi_cli.plans.models import (
    Plan,
    PlanOption,
    PlanStep,
    PlanExecution,
    StepExecution,
)
from kimi_cli.plans.detector import ComplexityDetector
from kimi_cli.plans.generator import PlanGenerator


@pytest.fixture
def sample_plan_option():
    """Create a sample PlanOption."""
    return PlanOption(
        id=1,
        title="Quick Fix",
        description="A fast solution to the problem",
        pros=["Fast", "Simple"],
        cons=["Technical debt"],
        estimated_time="15 min",
        approach_type="quick",
    )


@pytest.fixture
def sample_plan_options():
    """Create a list of sample PlanOptions."""
    return [
        PlanOption(
            id=1,
            title="Quick Fix",
            description="A fast solution",
            pros=["Fast", "Simple"],
            cons=["Technical debt"],
            estimated_time="15 min",
            approach_type="quick",
        ),
        PlanOption(
            id=2,
            title="Proper Solution",
            description="A comprehensive solution",
            pros=["Maintainable", "Well-tested"],
            cons=["Takes longer"],
            estimated_time="2 hours",
            approach_type="proper",
        ),
        PlanOption(
            id=3,
            title="Hybrid Approach",
            description="Balanced solution",
            pros=["Balanced", "Flexible"],
            cons=["Moderate complexity"],
            estimated_time="1 hour",
            approach_type="hybrid",
        ),
    ]


@pytest.fixture
def sample_plan_step():
    """Create a sample PlanStep."""
    return PlanStep(
        id="step_1",
        name="Setup",
        description="Initial setup step",
        depends_on=[],
        can_parallel=True,
        estimated_duration="5 min",
    )


@pytest.fixture
def sample_plan_steps():
    """Create a list of sample PlanSteps with dependencies."""
    return [
        PlanStep(
            id="step_1",
            name="Analyze",
            description="Analyze the codebase",
            depends_on=[],
            can_parallel=True,
            estimated_duration="10 min",
        ),
        PlanStep(
            id="step_2",
            name="Design",
            description="Design the solution",
            depends_on=["step_1"],
            can_parallel=False,
            estimated_duration="15 min",
        ),
        PlanStep(
            id="step_3",
            name="Implement",
            description="Implement the solution",
            depends_on=["step_2"],
            can_parallel=False,
            estimated_duration="30 min",
        ),
        PlanStep(
            id="step_4a",
            name="Test",
            description="Write tests",
            depends_on=["step_3"],
            can_parallel=True,
            estimated_duration="20 min",
        ),
        PlanStep(
            id="step_4b",
            name="Document",
            description="Write documentation",
            depends_on=["step_3"],
            can_parallel=True,
            estimated_duration="15 min",
        ),
    ]


@pytest.fixture
def sample_plan(sample_plan_options, sample_plan_steps):
    """Create a sample Plan with options and steps."""
    return Plan(
        id="test-plan-123",
        query="Implement user authentication",
        options=sample_plan_options,
        created_at=datetime(2024, 3, 4, 12, 0, 0),
        context_snapshot={
            "work_dir": "/tmp/project",
            "files": ["auth.py", "models.py"],
            "patterns": ["mvc"],
        },
        steps=sample_plan_steps,
    )


@pytest.fixture
def sample_step_execution():
    """Create a sample StepExecution."""
    return StepExecution(
        step_id="step_1",
        status="pending",
        started_at=None,
        completed_at=None,
        duration_seconds=0.0,
        retry_count=0,
        max_retries=3,
        error_message=None,
        files_modified=[],
        lines_added=0,
        lines_removed=0,
        output_summary="",
    )


@pytest.fixture
def sample_plan_execution(sample_step_execution):
    """Create a sample PlanExecution."""
    return PlanExecution(
        plan_id="test-plan-123",
        started_at=datetime(2024, 3, 4, 12, 0, 0),
        completed_at=None,
        steps=[sample_step_execution],
        overall_status="running",
        current_step_ids=["step_1"],
        checkpoint_path=None,
    )


@pytest.fixture
def complexity_detector():
    """Create a ComplexityDetector instance."""
    return ComplexityDetector()


@pytest.fixture
def mock_llm():
    """Create a mock LLM for testing PlanGenerator."""
    llm = MagicMock()
    llm.chat_provider = MagicMock()
    return llm


@pytest.fixture
def plan_generator(mock_llm):
    """Create a PlanGenerator with mocked LLM."""
    return PlanGenerator(llm=mock_llm)


@pytest.fixture
def mock_step_runner():
    """Create a mock StepRunner."""
    runner = MagicMock()
    runner.run = AsyncMock(return_value={
        "summary": "Step completed successfully",
        "files": ["test.py"],
        "lines_added": 10,
        "lines_removed": 2,
    })
    return runner

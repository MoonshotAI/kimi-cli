"""Tests for the plan scheduler module."""

import pytest
from datetime import datetime, timedelta
from unittest.mock import MagicMock, AsyncMock

from kimi_cli.plans.scheduler import PlanScheduler, ScheduledPlan
from kimi_cli.plans.models import Plan


class TestScheduledPlan:
    """Test the ScheduledPlan dataclass."""
    
    def test_scheduled_plan_creation(self):
        """Test creating a scheduled plan."""
        now = datetime.now()
        scheduled = ScheduledPlan(
            schedule_id="abc123",
            plan_id="plan_456",
            scheduled_at=now,
            run_at=now + timedelta(hours=1),
            query="test query",
            status="pending",
        )
        
        assert scheduled.schedule_id == "abc123"
        assert scheduled.plan_id == "plan_456"
        assert scheduled.status == "pending"


class TestPlanScheduler:
    """Test the PlanScheduler class."""
    
    def test_scheduler_initialization(self, tmp_path):
        """Test scheduler initialization."""
        scheduler = PlanScheduler()
        assert scheduler._schedule_file.name == "schedule.json"
        assert isinstance(scheduler._scheduled, list)
    
    def test_schedule_plan(self, tmp_path):
        """Test scheduling a plan."""
        scheduler = PlanScheduler()
        scheduler._scheduled = []  # Clear any loaded schedule
        
        plan = Plan(
            id="test_plan",
            query="test query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        
        future = datetime.now() + timedelta(hours=1)
        schedule_id = scheduler.schedule(plan, future)
        
        assert len(schedule_id) == 8  # UUID prefix
        assert len(scheduler.list_scheduled()) == 1
        
        scheduled = scheduler.list_scheduled()[0]
        assert scheduled.plan_id == "test_plan"
        assert scheduled.status == "pending"
    
    def test_get_pending_empty(self, tmp_path):
        """Test get_pending returns empty when no plans are due."""
        scheduler = PlanScheduler()
        scheduler._scheduled = []
        
        plan = Plan(
            id="test_plan",
            query="test query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        
        # Schedule for future
        future = datetime.now() + timedelta(hours=1)
        scheduler.schedule(plan, future)
        
        # Should be empty since run_at is in the future
        pending = scheduler.get_pending()
        assert len(pending) == 0
    
    def test_get_pending_ready(self, tmp_path):
        """Test get_pending returns plans that are ready."""
        scheduler = PlanScheduler()
        scheduler._scheduled = []
        
        plan = Plan(
            id="test_plan",
            query="test query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        
        # Schedule for past (already due)
        past = datetime.now() - timedelta(hours=1)
        scheduler.schedule(plan, past)
        
        # Should return the plan
        pending = scheduler.get_pending()
        assert len(pending) == 1
        assert pending[0].plan_id == "test_plan"
    
    def test_cancel_schedule(self, tmp_path):
        """Test cancelling a scheduled plan."""
        scheduler = PlanScheduler()
        scheduler._scheduled = []
        
        plan = Plan(
            id="test_plan",
            query="test query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        
        future = datetime.now() + timedelta(hours=1)
        schedule_id = scheduler.schedule(plan, future)
        
        # Cancel
        result = scheduler.cancel(schedule_id)
        assert result is True
        
        # Check status
        scheduled = scheduler.list_scheduled(include_completed=True)[0]
        assert scheduled.status == "cancelled"
    
    def test_cancel_nonexistent(self, tmp_path):
        """Test cancelling a non-existent schedule."""
        scheduler = PlanScheduler()
        
        result = scheduler.cancel("nonexistent")
        assert result is False
    
    def test_list_scheduled_filter(self, tmp_path):
        """Test list_scheduled filters completed plans."""
        scheduler = PlanScheduler()
        scheduler._scheduled = []
        
        plan = Plan(
            id="test_plan",
            query="test query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        
        future = datetime.now() + timedelta(hours=1)
        schedule_id = scheduler.schedule(plan, future)
        scheduler.cancel(schedule_id)
        
        # Without include_completed, should be empty
        assert len(scheduler.list_scheduled()) == 0
        
        # With include_completed, should show the cancelled plan
        assert len(scheduler.list_scheduled(include_completed=True)) == 1
    
    @pytest.mark.asyncio
    async def test_run_pending(self, tmp_path):
        """Test running pending plans."""
        scheduler = PlanScheduler()
        scheduler._scheduled = []
        
        plan = Plan(
            id="test_plan",
            query="test query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        
        # Mock the storage
        scheduler.storage = MagicMock()
        scheduler.storage.load.return_value = plan
        
        # Schedule for past
        past = datetime.now() - timedelta(hours=1)
        schedule_id = scheduler.schedule(plan, past)
        
        # Mock executor
        mock_executor = MagicMock()
        mock_executor.execute = AsyncMock()
        
        results = await scheduler.run_pending(mock_executor)
        
        assert len(results) == 1
        assert "completed" in results[0]
        mock_executor.execute.assert_called_once_with(plan)
    
    @pytest.mark.asyncio
    async def test_run_pending_no_plans(self, tmp_path):
        """Test running pending when no plans are due."""
        scheduler = PlanScheduler()
        scheduler._scheduled = []
        
        plan = Plan(
            id="test_plan",
            query="test query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        
        # Schedule for future
        future = datetime.now() + timedelta(hours=1)
        scheduler.schedule(plan, future)
        
        mock_executor = MagicMock()
        
        results = await scheduler.run_pending(mock_executor)
        
        assert len(results) == 0
        mock_executor.execute.assert_not_called()

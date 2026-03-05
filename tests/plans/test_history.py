"""Tests for the plan history module."""

import pytest
from datetime import datetime

from kimi_cli.plans.history import PlanHistory, HistoryEntry, get_history
from kimi_cli.plans.models import Plan, PlanExecution, StepExecution


class TestHistoryEntry:
    """Test the HistoryEntry dataclass."""
    
    def test_history_entry_creation(self):
        """Test creating a history entry."""
        entry = HistoryEntry(
            plan_id="test_plan",
            query="test query",
            started_at=datetime.now(),
            completed_at=None,
            outcome="unknown",
            files_changed=0,
        )
        assert entry.plan_id == "test_plan"
        assert entry.query == "test query"
        assert entry.outcome == "unknown"
        assert entry.files_changed == 0


class TestPlanHistory:
    """Test the PlanHistory class."""
    
    def test_empty_history(self):
        """Test empty history returns correct stats."""
        history = PlanHistory()
        stats = history.get_stats()
        
        assert stats["total"] == 0
        assert stats["success_rate"] == 0.0
        assert history.get_entries() == []
    
    def test_add_entry(self):
        """Test adding an entry to history."""
        history = PlanHistory()
        
        plan = Plan(
            id="test_123",
            query="test query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        execution = PlanExecution(
            plan_id="test_123",
            started_at=datetime.now(),
            completed_at=datetime.now(),
            overall_status="completed",
        )
        
        history.add(plan, execution)
        
        stats = history.get_stats()
        assert stats["total"] == 1
        assert stats["successful"] == 1
        assert stats["success_rate"] == 100.0
    
    def test_add_multiple_entries(self):
        """Test adding multiple entries."""
        history = PlanHistory()
        
        # Add successful execution
        plan1 = Plan(
            id="test_1",
            query="first query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        exec1 = PlanExecution(
            plan_id="test_1",
            started_at=datetime.now(),
            completed_at=datetime.now(),
            overall_status="completed",
        )
        history.add(plan1, exec1)
        
        # Add failed execution
        plan2 = Plan(
            id="test_2",
            query="second query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        exec2 = PlanExecution(
            plan_id="test_2",
            started_at=datetime.now(),
            completed_at=datetime.now(),
            overall_status="failed",
        )
        history.add(plan2, exec2)
        
        stats = history.get_stats()
        assert stats["total"] == 2
        assert stats["successful"] == 1
        assert stats["failed"] == 1
        assert stats["success_rate"] == 50.0
    
    def test_files_changed_counting(self):
        """Test that files changed are counted correctly."""
        history = PlanHistory()
        
        plan = Plan(
            id="test_files",
            query="test query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        execution = PlanExecution(
            plan_id="test_files",
            started_at=datetime.now(),
            completed_at=datetime.now(),
            overall_status="completed",
            steps=[
                StepExecution(
                    step_id="step1",
                    status="completed",
                    files_modified=["file1.py", "file2.py"],
                ),
                StepExecution(
                    step_id="step2",
                    status="completed",
                    files_modified=["file3.py"],
                ),
            ],
        )
        
        history.add(plan, execution)
        
        stats = history.get_stats()
        assert stats["total_files_changed"] == 3
    
    def test_get_entries_limit(self):
        """Test the limit parameter of get_entries."""
        history = PlanHistory()
        
        # Add 15 entries
        for i in range(15):
            plan = Plan(
                id=f"test_{i}",
                query=f"query {i}",
                options=[],
                created_at=datetime.now(),
                context_snapshot={},
            )
            execution = PlanExecution(
                plan_id=f"test_{i}",
                started_at=datetime.now(),
                completed_at=datetime.now(),
                overall_status="completed",
            )
            history.add(plan, execution)
        
        # Default limit is 10
        entries = history.get_entries()
        assert len(entries) == 10
        
        # Custom limit
        entries = history.get_entries(limit=5)
        assert len(entries) == 5
        
        # Limit larger than total
        entries = history.get_entries(limit=100)
        assert len(entries) == 15
    
    def test_clear_history(self):
        """Test clearing history."""
        history = PlanHistory()
        
        plan = Plan(
            id="test",
            query="test query",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
        )
        execution = PlanExecution(
            plan_id="test",
            started_at=datetime.now(),
            overall_status="completed",
        )
        history.add(plan, execution)
        
        assert history.get_stats()["total"] == 1
        
        history.clear()
        
        assert history.get_stats()["total"] == 0
        assert history.get_entries() == []


class TestGetHistory:
    """Test the global get_history function."""
    
    def test_global_history_instance(self):
        """Test that get_history returns the same instance."""
        history1 = get_history()
        history2 = get_history()
        
        assert history1 is history2
        assert isinstance(history1, PlanHistory)

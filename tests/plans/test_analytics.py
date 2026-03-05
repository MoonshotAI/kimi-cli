"""Tests for the plan analytics module."""

import pytest
from datetime import datetime, timedelta
from unittest.mock import MagicMock

from kimi_cli.plans.analytics import PlanAnalytics
from kimi_cli.plans.models import PlanExecution, StepExecution


class TestPlanAnalytics:
    """Test the PlanAnalytics class."""
    
    def test_empty_storage(self):
        """Test analytics with empty storage."""
        storage = MagicMock()
        storage.list.return_value = []
        
        checkpoint_mgr = MagicMock()
        
        analytics = PlanAnalytics(storage, checkpoint_mgr)
        stats = analytics.get_overall_stats()
        
        assert stats["total_plans"] == 0
    
    def test_plans_without_executions(self):
        """Test analytics with plans but no execution data."""
        storage = MagicMock()
        storage.list.return_value = [
            ("plan1", "query1", datetime.now()),
            ("plan2", "query2", datetime.now()),
        ]
        
        checkpoint_mgr = MagicMock()
        checkpoint_mgr.load.return_value = None
        
        analytics = PlanAnalytics(storage, checkpoint_mgr)
        stats = analytics.get_overall_stats()
        
        assert stats["total_plans"] == 2
        assert stats.get("executions", 0) == 0
    
    def test_single_completed_execution(self):
        """Test analytics with one completed execution."""
        storage = MagicMock()
        storage.list.return_value = [
            ("plan1", "query1", datetime.now()),
        ]
        
        checkpoint_mgr = MagicMock()
        checkpoint_mgr.load.return_value = PlanExecution(
            plan_id="plan1",
            started_at=datetime.now(),
            completed_at=datetime.now() + timedelta(minutes=5),
            overall_status="completed",
        )
        
        analytics = PlanAnalytics(storage, checkpoint_mgr)
        stats = analytics.get_overall_stats()
        
        assert stats["total_plans"] == 1
        assert stats["total_executions"] == 1
        assert stats["completed"] == 1
        assert stats["success_rate"] == 100.0
        assert stats["avg_execution_time_seconds"] == pytest.approx(300, rel=0.1)
    
    def test_mixed_executions(self):
        """Test analytics with mixed success/failure."""
        storage = MagicMock()
        storage.list.return_value = [
            ("plan1", "query1", datetime.now()),
            ("plan2", "query2", datetime.now()),
        ]
        
        now = datetime.now()
        executions = [
            PlanExecution(
                plan_id="plan1",
                started_at=now,
                completed_at=now + timedelta(minutes=5),
                overall_status="completed",
            ),
            PlanExecution(
                plan_id="plan2",
                started_at=now,
                completed_at=now + timedelta(minutes=3),
                overall_status="failed",
            ),
        ]
        
        checkpoint_mgr = MagicMock()
        checkpoint_mgr.load.side_effect = lambda plan_id: executions.pop(0) if executions else None
        
        analytics = PlanAnalytics(storage, checkpoint_mgr)
        stats = analytics.get_overall_stats()
        
        assert stats["total_executions"] == 2
        assert stats["completed"] == 1
        assert stats["failed"] == 1
        assert stats["success_rate"] == 50.0
    
    def test_partial_and_aborted(self):
        """Test analytics with partial and aborted statuses."""
        storage = MagicMock()
        storage.list.return_value = [
            ("plan1", "query1", datetime.now()),
            ("plan2", "query2", datetime.now()),
        ]
        
        now = datetime.now()
        executions = [
            PlanExecution(
                plan_id="plan1",
                started_at=now,
                completed_at=now + timedelta(minutes=5),
                overall_status="partial",
            ),
            PlanExecution(
                plan_id="plan2",
                started_at=now,
                completed_at=now + timedelta(minutes=3),
                overall_status="aborted",
            ),
        ]
        
        checkpoint_mgr = MagicMock()
        checkpoint_mgr.load.side_effect = lambda plan_id: executions.pop(0) if executions else None
        
        analytics = PlanAnalytics(storage, checkpoint_mgr)
        stats = analytics.get_overall_stats()
        
        assert stats["partial"] == 1
        assert stats["aborted"] == 1
        assert stats["success_rate"] == 0.0  # Only "completed" counts as success
    
    def test_avg_execution_time(self):
        """Test average execution time calculation."""
        storage = MagicMock()
        storage.list.return_value = [
            ("plan1", "query1", datetime.now()),
            ("plan2", "query2", datetime.now()),
        ]
        
        now = datetime.now()
        executions = [
            PlanExecution(
                plan_id="plan1",
                started_at=now,
                completed_at=now + timedelta(seconds=100),
                overall_status="completed",
            ),
            PlanExecution(
                plan_id="plan2",
                started_at=now,
                completed_at=now + timedelta(seconds=200),
                overall_status="completed",
            ),
        ]
        
        checkpoint_mgr = MagicMock()
        checkpoint_mgr.load.side_effect = lambda plan_id: executions.pop(0) if executions else None
        
        analytics = PlanAnalytics(storage, checkpoint_mgr)
        stats = analytics.get_overall_stats()
        
        assert stats["avg_execution_time_seconds"] == 150.0
    
    def test_trends_empty(self):
        """Test trends with no recent activity."""
        storage = MagicMock()
        storage.list.return_value = []
        
        checkpoint_mgr = MagicMock()
        
        analytics = PlanAnalytics(storage, checkpoint_mgr)
        trends = analytics.get_trends(days=7)
        
        assert trends["period_days"] == 7
        assert trends["total_recent"] == 0
        assert trends["daily_executions"] == {}
    
    def test_trends_with_data(self):
        """Test trends calculation with recent data."""
        now = datetime.now()
        today = now.strftime("%Y-%m-%d")
        
        storage = MagicMock()
        storage.list.return_value = [
            ("plan1", "query1", now),
        ]
        
        checkpoint_mgr = MagicMock()
        checkpoint_mgr.load.return_value = PlanExecution(
            plan_id="plan1",
            started_at=now,
            completed_at=now,
            overall_status="completed",
        )
        
        analytics = PlanAnalytics(storage, checkpoint_mgr)
        trends = analytics.get_trends(days=7)
        
        assert trends["total_recent"] == 1
        assert trends["daily_executions"][today] == 1
    
    def test_trends_old_data_filtered(self):
        """Test that old data is filtered from trends."""
        old_date = datetime.now() - timedelta(days=30)
        
        storage = MagicMock()
        storage.list.return_value = [
            ("plan1", "query1", old_date),
        ]
        
        checkpoint_mgr = MagicMock()
        checkpoint_mgr.load.return_value = PlanExecution(
            plan_id="plan1",
            started_at=old_date,
            completed_at=old_date,
            overall_status="completed",
        )
        
        analytics = PlanAnalytics(storage, checkpoint_mgr)
        trends = analytics.get_trends(days=7)
        
        # Old data should be filtered out
        assert trends["total_recent"] == 0
    
    def test_export_report(self, tmp_path):
        """Test report export to JSON."""
        import json
        
        storage = MagicMock()
        storage.list.return_value = []
        
        checkpoint_mgr = MagicMock()
        
        analytics = PlanAnalytics(storage, checkpoint_mgr)
        
        output_path = tmp_path / "report.json"
        analytics.export_report(output_path)
        
        assert output_path.exists()
        
        data = json.loads(output_path.read_text())
        assert "generated_at" in data
        assert "overall" in data
        assert "trends" in data

"""
Plan analytics and statistics across all saved plans.

This module provides the PlanAnalytics class for analyzing plan execution
data across all saved plans, including success rates, trends, and reports.
"""

from pathlib import Path
from typing import Dict, List, Optional
import json
from datetime import datetime, timedelta

from .storage import PlanStorage
from .checkpoint import CheckpointManager


class PlanAnalytics:
    """Analytics across all saved plans."""
    
    def __init__(self, storage: PlanStorage, checkpoint_manager: CheckpointManager):
        self.storage = storage
        self.checkpoint_manager = checkpoint_manager
    
    def get_overall_stats(self) -> Dict:
        """Get statistics across all saved plans."""
        plans = self.storage.list()
        if not plans:
            return {"total_plans": 0}
        
        executions = []
        for plan_id, _, _ in plans:
            exec_data = self.checkpoint_manager.load(plan_id)
            if exec_data:
                executions.append(exec_data)
        
        if not executions:
            return {"total_plans": len(plans), "executions": 0}
        
        completed = sum(1 for e in executions if e.overall_status == "completed")
        failed = sum(1 for e in executions if e.overall_status == "failed")
        aborted = sum(1 for e in executions if e.overall_status == "aborted")
        partial = sum(1 for e in executions if e.overall_status == "partial")
        
        durations = [
            (e.completed_at - e.started_at).total_seconds()
            for e in executions
            if e.completed_at and e.started_at
        ]
        avg_duration = sum(durations) / len(durations) if durations else 0
        
        return {
            "total_plans": len(plans),
            "total_executions": len(executions),
            "completed": completed,
            "failed": failed,
            "aborted": aborted,
            "partial": partial,
            "success_rate": completed / len(executions) * 100 if executions else 0,
            "avg_execution_time_seconds": avg_duration,
        }
    
    def get_trends(self, days: int = 7) -> Dict:
        """Get usage trends over time."""
        cutoff = datetime.now() - timedelta(days=days)
        plans = self.storage.list()
        
        recent = []
        for plan_id, _, created_at in plans:
            if created_at > cutoff:
                exec_data = self.checkpoint_manager.load(plan_id)
                if exec_data:
                    recent.append(exec_data)
        
        # Group by day
        daily = {}
        for e in recent:
            day = e.started_at.strftime("%Y-%m-%d")
            daily.setdefault(day, []).append(e)
        
        return {
            "period_days": days,
            "daily_executions": {day: len(execs) for day, execs in daily.items()},
            "total_recent": len(recent),
        }
    
    def export_report(self, output_path: Path) -> None:
        """Export analytics report to JSON."""
        report = {
            "generated_at": datetime.now().isoformat(),
            "overall": self.get_overall_stats(),
            "trends": self.get_trends(),
        }
        output_path.write_text(json.dumps(report, indent=2, default=str))

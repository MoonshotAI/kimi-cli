"""
Plan scheduler for delayed execution.

This module provides the PlanScheduler class for queuing plans
for later execution at a scheduled time.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional
from pathlib import Path
import json
import uuid

from .models import Plan
from .storage import PlanStorage


@dataclass
class ScheduledPlan:
    """A plan scheduled for future execution."""
    schedule_id: str
    plan_id: str
    scheduled_at: datetime
    run_at: datetime
    query: str
    status: str = "pending"  # pending, running, completed, cancelled, failed


class PlanScheduler:
    """Queue plans for later execution."""
    
    def __init__(self, storage: Optional[PlanStorage] = None):
        self.storage = storage or PlanStorage()
        self._schedule_file = Path.home() / ".kimi" / "schedule.json"
        self._scheduled: List[ScheduledPlan] = []
        self._load_schedule()
    
    def _load_schedule(self) -> None:
        """Load scheduled plans from disk."""
        if self._schedule_file.exists():
            try:
                data = json.loads(self._schedule_file.read_text())
                self._scheduled = []
                for item in data:
                    self._scheduled.append(ScheduledPlan(
                        schedule_id=item["schedule_id"],
                        plan_id=item["plan_id"],
                        scheduled_at=datetime.fromisoformat(item["scheduled_at"]),
                        run_at=datetime.fromisoformat(item["run_at"]),
                        query=item["query"],
                        status=item["status"],
                    ))
            except (json.JSONDecodeError, KeyError, ValueError):
                self._scheduled = []
    
    def _save_schedule(self) -> None:
        """Save scheduled plans to disk."""
        data = [
            {
                "schedule_id": s.schedule_id,
                "plan_id": s.plan_id,
                "scheduled_at": s.scheduled_at.isoformat(),
                "run_at": s.run_at.isoformat(),
                "query": s.query,
                "status": s.status,
            }
            for s in self._scheduled
        ]
        self._schedule_file.write_text(json.dumps(data, indent=2, default=str))
    
    def schedule(self, plan: Plan, run_at: datetime) -> str:
        """Schedule a plan for later execution.
        
        Args:
            plan: The plan to schedule
            run_at: When to execute the plan
            
        Returns:
            schedule_id: Unique identifier for the scheduled plan
        """
        schedule_id = str(uuid.uuid4())[:8]
        
        entry = ScheduledPlan(
            schedule_id=schedule_id,
            plan_id=plan.id,
            scheduled_at=datetime.now(),
            run_at=run_at,
            query=plan.query,
        )
        self._scheduled.append(entry)
        self._save_schedule()
        return schedule_id
    
    def get_pending(self) -> List[ScheduledPlan]:
        """Get pending scheduled plans that are ready to run."""
        now = datetime.now()
        return [
            s for s in self._scheduled 
            if s.status == "pending" and s.run_at <= now
        ]
    
    def list_scheduled(self, include_completed: bool = False) -> List[ScheduledPlan]:
        """List all scheduled plans.
        
        Args:
            include_completed: Whether to include completed/cancelled plans
            
        Returns:
            List of scheduled plans sorted by run_at time
        """
        if include_completed:
            return sorted(self._scheduled, key=lambda s: s.run_at)
        else:
            return sorted(
                [s for s in self._scheduled if s.status == "pending"],
                key=lambda s: s.run_at
            )
    
    def cancel(self, schedule_id: str) -> bool:
        """Cancel a scheduled plan.
        
        Args:
            schedule_id: The schedule ID to cancel
            
        Returns:
            True if cancelled, False if not found or already running
        """
        for s in self._scheduled:
            if s.schedule_id == schedule_id and s.status == "pending":
                s.status = "cancelled"
                self._save_schedule()
                return True
        return False
    
    async def run_pending(self, executor) -> List[str]:
        """Run all pending scheduled plans.
        
        Args:
            executor: PlanExecutor instance to use for execution
            
        Returns:
            List of result messages for each plan executed
        """
        pending = self.get_pending()
        results = []
        for entry in pending:
            plan = self.storage.load(entry.plan_id)
            if plan:
                entry.status = "running"
                self._save_schedule()
                try:
                    execution = await executor.execute(plan)
                    entry.status = "completed"
                    results.append(f"{entry.schedule_id}: completed")
                except Exception as e:
                    entry.status = "failed"
                    results.append(f"{entry.schedule_id}: failed - {e}")
                self._save_schedule()
            else:
                entry.status = "failed"
                results.append(f"{entry.schedule_id}: failed - plan not found")
                self._save_schedule()
        return results

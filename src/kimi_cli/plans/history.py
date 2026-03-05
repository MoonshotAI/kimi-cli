"""
Plan history tracking for the current session.

This module provides the PlanHistory class for tracking executed plans
in the current session, with statistics and history entries.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Dict, Optional

from .models import Plan, PlanExecution


@dataclass
class HistoryEntry:
    """Entry for a single plan execution in history."""
    plan_id: str
    query: str
    started_at: datetime
    completed_at: Optional[datetime] = None
    outcome: str = "unknown"  # success, failed, aborted
    files_changed: int = 0


class PlanHistory:
    """Track plans in current session."""
    
    def __init__(self):
        self._entries: List[HistoryEntry] = []
    
    def add(self, plan: Plan, execution: PlanExecution) -> None:
        """Add completed plan to history."""
        # Calculate files changed from execution steps
        files_changed = sum(
            len(step.files_modified) for step in execution.steps
        )
        
        entry = HistoryEntry(
            plan_id=plan.id,
            query=plan.query,
            started_at=execution.started_at,
            completed_at=execution.completed_at,
            outcome=execution.overall_status,
            files_changed=files_changed,
        )
        self._entries.append(entry)
    
    def get_entries(self, limit: int = 10) -> List[HistoryEntry]:
        """Get recent history entries."""
        return self._entries[-limit:]
    
    def get_stats(self) -> Dict:
        """Get session statistics."""
        if not self._entries:
            return {"total": 0, "success_rate": 0.0}
        
        total = len(self._entries)
        successful = sum(1 for e in self._entries if e.outcome == "completed")
        
        durations = [
            (e.completed_at - e.started_at).total_seconds()
            for e in self._entries
            if e.completed_at
        ]
        avg_duration = sum(durations) / len(durations) if durations else 0
        
        return {
            "total": total,
            "successful": successful,
            "failed": total - successful,
            "success_rate": successful / total * 100,
            "avg_duration_seconds": avg_duration,
            "total_files_changed": sum(e.files_changed for e in self._entries),
        }
    
    def clear(self) -> None:
        """Clear history."""
        self._entries.clear()


# Global instance for current session
_session_history = PlanHistory()


def get_history() -> PlanHistory:
    """Get the global session history instance."""
    return _session_history

"""
Checkpoint save/load system for plan execution state.

This module provides functionality to save and restore execution checkpoints,
allowing plans to be resumed after interruption.
"""

import json
from pathlib import Path
from datetime import datetime
from typing import Any

from kimi_cli.plans.models import PlanExecution, StepExecution


class CheckpointManager:
    """Save and restore execution checkpoints."""
    
    DIR = Path.home() / ".kimi" / "checkpoints"
    
    def __init__(self):
        self.DIR.mkdir(parents=True, exist_ok=True)
    
    def save(self, execution: PlanExecution) -> Path:
        """Save execution checkpoint to disk.
        
        Args:
            execution: Current execution state
            
        Returns:
            Path to saved checkpoint file
        """
        filepath = self.DIR / f"{execution.plan_id}.json"
        data = self._execution_to_dict(execution)
        
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2, default=str)
        
        return filepath
    
    def load(self, plan_id: str) -> PlanExecution | None:
        """Load checkpoint for plan.
        
        Args:
            plan_id: Plan ID
            
        Returns:
            PlanExecution or None if not found
        """
        filepath = self.DIR / f"{plan_id}.json"
        if not filepath.exists():
            return None
        
        with open(filepath) as f:
            data = json.load(f)
        
        return self._execution_from_dict(data)
    
    def exists(self, plan_id: str) -> bool:
        """Check if checkpoint exists for plan."""
        return (self.DIR / f"{plan_id}.json").exists()
    
    def delete(self, plan_id: str) -> bool:
        """Delete checkpoint.
        
        Returns:
            True if deleted, False if didn't exist
        """
        filepath = self.DIR / f"{plan_id}.json"
        if filepath.exists():
            filepath.unlink()
            return True
        return False
    
    def should_resume(self, plan_id: str) -> bool:
        """Check if plan should resume from checkpoint.
        
        Returns True if:
        - Checkpoint exists
        - Execution was not completed
        """
        if not self.exists(plan_id):
            return False
        
        execution = self.load(plan_id)
        if execution is None:
            return False
        
        return execution.overall_status == "running"
    
    def list(self) -> list[tuple[str, datetime]]:
        """List all checkpoints.
        
        Returns:
            List of (plan_id, modified_at) tuples
        """
        checkpoints = []
        for filepath in self.DIR.glob("*.json"):
            plan_id = filepath.stem
            mtime = datetime.fromtimestamp(filepath.stat().st_mtime)
            checkpoints.append((plan_id, mtime))
        
        return sorted(checkpoints, key=lambda x: x[1], reverse=True)
    
    def _execution_to_dict(self, execution: PlanExecution) -> dict[str, Any]:
        """Serialize execution to dict."""
        return {
            "plan_id": execution.plan_id,
            "started_at": execution.started_at.isoformat(),
            "completed_at": execution.completed_at.isoformat() if execution.completed_at else None,
            "overall_status": execution.overall_status,
            "current_step_ids": execution.current_step_ids,
            "checkpoint_path": str(execution.checkpoint_path) if execution.checkpoint_path else None,
            "steps": [
                {
                    "step_id": step.step_id,
                    "status": step.status,
                    "started_at": step.started_at.isoformat() if step.started_at else None,
                    "completed_at": step.completed_at.isoformat() if step.completed_at else None,
                    "duration_seconds": step.duration_seconds,
                    "retry_count": step.retry_count,
                    "max_retries": step.max_retries,
                    "error_message": step.error_message,
                    "files_modified": step.files_modified,
                    "lines_added": step.lines_added,
                    "lines_removed": step.lines_removed,
                    "output_summary": step.output_summary,
                }
                for step in execution.steps
            ]
        }
    
    def _execution_from_dict(self, data: dict[str, Any]) -> PlanExecution:
        """Deserialize execution from dict."""
        steps = [
            StepExecution(
                step_id=s["step_id"],
                status=s["status"],
                started_at=datetime.fromisoformat(s["started_at"]) if s["started_at"] else None,
                completed_at=datetime.fromisoformat(s["completed_at"]) if s["completed_at"] else None,
                duration_seconds=s["duration_seconds"],
                retry_count=s["retry_count"],
                max_retries=s["max_retries"],
                error_message=s["error_message"],
                files_modified=s["files_modified"],
                lines_added=s["lines_added"],
                lines_removed=s["lines_removed"],
                output_summary=s["output_summary"],
            )
            for s in data["steps"]
        ]
        
        return PlanExecution(
            plan_id=data["plan_id"],
            started_at=datetime.fromisoformat(data["started_at"]),
            completed_at=datetime.fromisoformat(data["completed_at"]) if data["completed_at"] else None,
            overall_status=data["overall_status"],
            steps=steps,
            current_step_ids=data["current_step_ids"],
            checkpoint_path=Path(data["checkpoint_path"]) if data["checkpoint_path"] else None,
        )

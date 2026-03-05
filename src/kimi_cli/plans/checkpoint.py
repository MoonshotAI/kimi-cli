"""Checkpoint save/load system for plan execution state.

This module provides functionality to save and restore execution checkpoints,
allowing plans to be resumed after interruption.
"""

import json
import shutil
from pathlib import Path
from datetime import datetime
from typing import Any, Optional

from kimi_cli.plans.models import PlanExecution, StepExecution
from kimi_cli.plans.errors import DiskFullError, CheckpointCorruptedError


class CheckpointManager:
    """Save and restore execution checkpoints."""
    
    DIR = Path.home() / ".kimi" / "checkpoints"
    BACKUP_SUFFIX = ".backup"
    CORRUPTED_SUFFIX = ".corrupted"
    
    def __init__(self):
        self.DIR.mkdir(parents=True, exist_ok=True)
    
    def save(self, execution: PlanExecution) -> Path:
        """Save execution checkpoint to disk.
        
        Args:
            execution: Current execution state
            
        Returns:
            Path to saved checkpoint file
            
        Raises:
            DiskFullError: If disk is full
        """
        filepath = self.DIR / f"{execution.plan_id}.json"
        data = self._execution_to_dict(execution)
        
        try:
            # Write to temp file first for atomic operation
            temp_file = filepath.with_suffix('.tmp')
            with open(temp_file, 'w') as f:
                json.dump(data, f, indent=2, default=str)
            
            # Atomic rename
            temp_file.rename(filepath)
            
        except OSError as e:
            # Clean up temp file if it exists
            if temp_file.exists():
                try:
                    temp_file.unlink()
                except Exception:
                    pass
            
            # Check for disk full error
            error_str = str(e).lower()
            if "no space left on device" in error_str or "nospace" in error_str or "disk full" in error_str:
                raise DiskFullError(f"Cannot save checkpoint: disk full ({filepath})")
            raise
        
        return filepath
    
    def load(self, plan_id: str) -> Optional[PlanExecution]:
        """Load checkpoint for plan.
        
        Args:
            plan_id: Plan ID
            
        Returns:
            PlanExecution or None if not found
            
        Raises:
            CheckpointCorruptedError: If checkpoint file is corrupted
        """
        filepath = self.DIR / f"{plan_id}.json"
        if not filepath.exists():
            return None
        
        try:
            with open(filepath) as f:
                data = json.load(f)
            
            return self._execution_from_dict(data)
            
        except json.JSONDecodeError as e:
            # Move corrupted file aside and try backup
            corrupted_path = filepath.with_suffix(self.CORRUPTED_SUFFIX)
            try:
                shutil.move(str(filepath), str(corrupted_path))
            except Exception:
                pass
            raise CheckpointCorruptedError(f"Checkpoint corrupted: {e}")
            
        except (KeyError, TypeError, ValueError) as e:
            # Data structure errors
            corrupted_path = filepath.with_suffix(self.CORRUPTED_SUFFIX)
            try:
                shutil.move(str(filepath), str(corrupted_path))
            except Exception:
                pass
            raise CheckpointCorruptedError(f"Checkpoint data invalid: {e}")
    
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
        
        try:
            execution = self.load(plan_id)
            if execution is None:
                return False
            
            return execution.overall_status == "running"
        except CheckpointCorruptedError:
            # Try to recover
            execution = self.try_recover(plan_id)
            if execution:
                return execution.overall_status == "running"
            return False
    
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
    
    def try_recover(self, plan_id: str) -> Optional[PlanExecution]:
        """Try to recover from corrupted checkpoint.
        
        Attempts to:
        1. Load backup checkpoint if available
        2. Parse partial data from corrupted file
        
        Args:
            plan_id: Plan ID to recover
            
        Returns:
            Recovered PlanExecution or None if unrecoverable
        """
        # Try backup file first
        backup_path = self.DIR / f"{plan_id}.json{self.BACKUP_SUFFIX}"
        if backup_path.exists():
            try:
                with open(backup_path) as f:
                    data = json.load(f)
                return self._execution_from_dict(data)
            except Exception:
                pass
        
        # Try corrupted file
        corrupted_path = self.DIR / f"{plan_id}.json{self.CORRUPTED_SUFFIX}"
        if corrupted_path.exists():
            try:
                # Try to parse partial JSON
                text = corrupted_path.read_text()
                # Find first valid JSON object
                for end in range(len(text), 0, -1):
                    try:
                        data = json.loads(text[:end])
                        return self._execution_from_dict(data)
                    except (json.JSONDecodeError, KeyError, TypeError):
                        continue
            except Exception:
                pass
        
        return None
    
    def create_backup(self, plan_id: str) -> Optional[Path]:
        """Create backup of current checkpoint.
        
        Args:
            plan_id: Plan ID to backup
            
        Returns:
            Path to backup file or None if no checkpoint exists
        """
        filepath = self.DIR / f"{plan_id}.json"
        if not filepath.exists():
            return None
        
        backup_path = filepath.with_suffix(self.BACKUP_SUFFIX)
        shutil.copy2(str(filepath), str(backup_path))
        return backup_path
    
    def cleanup_old_checkpoints(self, max_age_days: int = 7) -> int:
        """Remove old checkpoint files.
        
        Args:
            max_age_days: Maximum age in days
            
        Returns:
            Number of files removed
        """
        from datetime import timedelta
        
        cutoff = datetime.now() - timedelta(days=max_age_days)
        removed = 0
        
        for filepath in self.DIR.glob("*.json"):
            try:
                mtime = datetime.fromtimestamp(filepath.stat().st_mtime)
                if mtime < cutoff:
                    filepath.unlink()
                    removed += 1
            except Exception:
                pass
        
        return removed
    
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

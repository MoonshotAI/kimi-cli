"""
Execution history for undo/redo functionality.

This module provides the ExecutionHistory class for tracking file changes
before plan step execution, allowing users to undo changes if needed.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional, Dict
from pathlib import Path
import json


@dataclass
class FileSnapshot:
    """Snapshot of a file before modification."""
    path: str
    content: Optional[str]
    exists: bool


@dataclass
class StepSnapshot:
    """Snapshot before a step execution."""
    step_number: int
    timestamp: datetime
    file_snapshots: List[FileSnapshot] = field(default_factory=list)
    description: str = ""


class ExecutionHistory:
    """Track changes for undo/redo."""
    
    def __init__(self, max_history: int = 10):
        self._snapshots: List[StepSnapshot] = []
        self._redo_stack: List[StepSnapshot] = []
        self.max_history = max_history
    
    def snapshot(self, step_number: int, file_paths: List[str], description: str = "") -> None:
        """Take snapshot before executing a step.
        
        Args:
            step_number: The step number being executed
            file_paths: List of file paths that might be modified
            description: Description of the step
        """
        snapshots = []
        for path_str in file_paths:
            path = Path(path_str)
            if path.exists():
                try:
                    content = path.read_text()
                    snapshots.append(FileSnapshot(str(path), content, True))
                except Exception:
                    # Skip files that can't be read
                    pass
            else:
                snapshots.append(FileSnapshot(str(path), None, False))
        
        step_snap = StepSnapshot(
            step_number=step_number,
            timestamp=datetime.now(),
            file_snapshots=snapshots,
            description=description,
        )
        
        self._snapshots.append(step_snap)
        if len(self._snapshots) > self.max_history:
            self._snapshots.pop(0)
        
        self._redo_stack.clear()  # Clear redo on new action
    
    def undo(self) -> Optional[str]:
        """Undo last step. Returns description or None.
        
        Returns:
            Description of the undone step, or None if nothing to undo
        """
        if not self._snapshots:
            return None
        
        snapshot = self._snapshots.pop()
        self._redo_stack.append(snapshot)
        
        # Restore files
        for file_snap in snapshot.file_snapshots:
            path = Path(file_snap.path)
            if file_snap.exists:
                path.write_text(file_snap.content or "")
            else:
                if path.exists():
                    path.unlink()
        
        return snapshot.description
    
    def redo(self) -> Optional[str]:
        """Redo previously undone step.
        
        Note: Redo requires storing the "after" state.
        For simplicity, this is a placeholder returning None.
        
        Returns:
            None (redo not fully implemented)
        """
        # Note: Redo requires storing the "after" state
        # For simplicity, this is a placeholder
        return None
    
    def can_undo(self) -> bool:
        """Check if undo is available."""
        return len(self._snapshots) > 0
    
    def can_redo(self) -> bool:
        """Check if redo is available."""
        return len(self._redo_stack) > 0
    
    def get_history(self) -> List[Dict]:
        """Get history summary.
        
        Returns:
            List of dicts with step info, time, description, and file count
        """
        return [
            {
                "step": s.step_number,
                "time": s.timestamp.isoformat(),
                "description": s.description,
                "files": len(s.file_snapshots),
            }
            for s in self._snapshots
        ]
    
    def clear(self) -> None:
        """Clear all history."""
        self._snapshots.clear()
        self._redo_stack.clear()


# Global instance
_execution_history = ExecutionHistory()


def get_execution_history() -> ExecutionHistory:
    """Get the global execution history instance."""
    return _execution_history

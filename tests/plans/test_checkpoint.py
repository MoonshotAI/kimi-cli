"""Tests for plans.checkpoint module."""

import pytest
import json
from datetime import datetime
from pathlib import Path
from unittest.mock import patch, mock_open

from kimi_cli.plans.checkpoint import CheckpointManager
from kimi_cli.plans.models import PlanExecution, StepExecution


class TestCheckpointManagerInit:
    """Tests for CheckpointManager initialization."""

    def test_init_creates_directory(self, tmp_path):
        """Test initialization creates checkpoint directory."""
        with patch.object(CheckpointManager, 'DIR', tmp_path / ".kimi" / "checkpoints"):
            manager = CheckpointManager()
            assert manager.DIR.exists()

    def test_init_existing_directory(self, tmp_path):
        """Test initialization with existing directory."""
        checkpoint_dir = tmp_path / ".kimi" / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            assert manager.DIR.exists()


class TestCheckpointManagerSave:
    """Tests for CheckpointManager.save method."""

    def test_save_creates_file(self, tmp_path):
        """Test save creates checkpoint file."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            execution = PlanExecution(
                plan_id="plan-123",
                started_at=datetime(2024, 3, 4, 12, 0, 0),
                steps=[
                    StepExecution(step_id="step_1", status="completed"),
                    StepExecution(step_id="step_2", status="running"),
                ],
                overall_status="running",
                current_step_ids=["step_2"],
            )
            
            path = manager.save(execution)
            
            assert path.exists()
            assert path.name == "plan-123.json"

    def test_save_serializes_correctly(self, tmp_path):
        """Test save serializes execution correctly."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            execution = PlanExecution(
                plan_id="plan-123",
                started_at=datetime(2024, 3, 4, 12, 0, 0),
                completed_at=datetime(2024, 3, 4, 12, 30, 0),
                steps=[
                    StepExecution(
                        step_id="step_1",
                        status="completed",
                        started_at=datetime(2024, 3, 4, 12, 0, 0),
                        completed_at=datetime(2024, 3, 4, 12, 15, 0),
                        duration_seconds=900.0,
                        retry_count=0,
                        max_retries=3,
                        error_message=None,
                        files_modified=["file.py"],
                        lines_added=10,
                        lines_removed=2,
                        output_summary="Did work",
                    ),
                ],
                overall_status="completed",
                current_step_ids=[],
                checkpoint_path=None,
            )
            
            manager.save(execution)
            
            filepath = checkpoint_dir / "plan-123.json"
            with open(filepath) as f:
                data = json.load(f)
            
            assert data["plan_id"] == "plan-123"
            assert data["overall_status"] == "completed"
            assert data["started_at"] == "2024-03-04T12:00:00"
            assert data["completed_at"] == "2024-03-04T12:30:00"
            assert len(data["steps"]) == 1
            assert data["steps"][0]["step_id"] == "step_1"
            assert data["steps"][0]["status"] == "completed"
            assert data["steps"][0]["duration_seconds"] == 900.0
            assert data["steps"][0]["files_modified"] == ["file.py"]
            assert data["steps"][0]["output_summary"] == "Did work"


class TestCheckpointManagerLoad:
    """Tests for CheckpointManager.load method."""

    def test_load_existing_checkpoint(self, tmp_path):
        """Test loading existing checkpoint."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        # Create a checkpoint file
        checkpoint_data = {
            "plan_id": "plan-123",
            "started_at": "2024-03-04T12:00:00",
            "completed_at": None,
            "overall_status": "running",
            "current_step_ids": ["step_1"],
            "checkpoint_path": None,
            "steps": [
                {
                    "step_id": "step_1",
                    "status": "running",
                    "started_at": "2024-03-04T12:00:00",
                    "completed_at": None,
                    "duration_seconds": 0.0,
                    "retry_count": 0,
                    "max_retries": 3,
                    "error_message": None,
                    "files_modified": [],
                    "lines_added": 0,
                    "lines_removed": 0,
                    "output_summary": "",
                }
            ]
        }
        
        filepath = checkpoint_dir / "plan-123.json"
        with open(filepath, 'w') as f:
            json.dump(checkpoint_data, f)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            execution = manager.load("plan-123")
            
            assert execution is not None
            assert execution.plan_id == "plan-123"
            assert execution.overall_status == "running"
            assert len(execution.steps) == 1
            assert execution.steps[0].step_id == "step_1"
            assert execution.steps[0].status == "running"

    def test_load_nonexistent_checkpoint(self, tmp_path):
        """Test loading non-existent checkpoint returns None."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            execution = manager.load("nonexistent")
            
            assert execution is None

    def test_load_deserializes_timestamps(self, tmp_path):
        """Test load deserializes timestamps correctly."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        checkpoint_data = {
            "plan_id": "plan-123",
            "started_at": "2024-03-04T12:00:00",
            "completed_at": "2024-03-04T12:30:00",
            "overall_status": "completed",
            "current_step_ids": [],
            "checkpoint_path": None,
            "steps": [
                {
                    "step_id": "step_1",
                    "status": "completed",
                    "started_at": "2024-03-04T12:00:00",
                    "completed_at": "2024-03-04T12:15:00",
                    "duration_seconds": 900.0,
                    "retry_count": 0,
                    "max_retries": 3,
                    "error_message": None,
                    "files_modified": ["file.py"],
                    "lines_added": 10,
                    "lines_removed": 2,
                    "output_summary": "Done",
                }
            ]
        }
        
        filepath = checkpoint_dir / "plan-123.json"
        with open(filepath, 'w') as f:
            json.dump(checkpoint_data, f)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            execution = manager.load("plan-123")
            
            assert execution.started_at == datetime(2024, 3, 4, 12, 0, 0)
            assert execution.completed_at == datetime(2024, 3, 4, 12, 30, 0)
            assert execution.steps[0].started_at == datetime(2024, 3, 4, 12, 0, 0)
            assert execution.steps[0].completed_at == datetime(2024, 3, 4, 12, 15, 0)


class TestCheckpointManagerExists:
    """Tests for CheckpointManager.exists method."""

    def test_exists_true(self, tmp_path):
        """Test exists returns True for existing checkpoint."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        filepath = checkpoint_dir / "plan-123.json"
        filepath.touch()
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            assert manager.exists("plan-123") is True

    def test_exists_false(self, tmp_path):
        """Test exists returns False for non-existent checkpoint."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            assert manager.exists("nonexistent") is False


class TestCheckpointManagerDelete:
    """Tests for CheckpointManager.delete method."""

    def test_delete_existing(self, tmp_path):
        """Test delete removes existing checkpoint."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        filepath = checkpoint_dir / "plan-123.json"
        filepath.touch()
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            result = manager.delete("plan-123")
            
            assert result is True
            assert not filepath.exists()

    def test_delete_nonexistent(self, tmp_path):
        """Test delete returns False for non-existent checkpoint."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            result = manager.delete("nonexistent")
            
            assert result is False


class TestCheckpointManagerShouldResume:
    """Tests for CheckpointManager.should_resume method."""

    def test_should_resume_true_for_running(self, tmp_path):
        """Test should_resume returns True for running execution."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        checkpoint_data = {
            "plan_id": "plan-123",
            "started_at": "2024-03-04T12:00:00",
            "completed_at": None,
            "overall_status": "running",
            "current_step_ids": [],
            "checkpoint_path": None,
            "steps": []
        }
        
        filepath = checkpoint_dir / "plan-123.json"
        with open(filepath, 'w') as f:
            json.dump(checkpoint_data, f)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            assert manager.should_resume("plan-123") is True

    def test_should_resume_false_for_completed(self, tmp_path):
        """Test should_resume returns False for completed execution."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        checkpoint_data = {
            "plan_id": "plan-123",
            "started_at": "2024-03-04T12:00:00",
            "completed_at": "2024-03-04T12:30:00",
            "overall_status": "completed",
            "current_step_ids": [],
            "checkpoint_path": None,
            "steps": []
        }
        
        filepath = checkpoint_dir / "plan-123.json"
        with open(filepath, 'w') as f:
            json.dump(checkpoint_data, f)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            assert manager.should_resume("plan-123") is False

    def test_should_resume_false_for_failed(self, tmp_path):
        """Test should_resume returns False for failed execution."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        checkpoint_data = {
            "plan_id": "plan-123",
            "started_at": "2024-03-04T12:00:00",
            "completed_at": "2024-03-04T12:30:00",
            "overall_status": "failed",
            "current_step_ids": [],
            "checkpoint_path": None,
            "steps": []
        }
        
        filepath = checkpoint_dir / "plan-123.json"
        with open(filepath, 'w') as f:
            json.dump(checkpoint_data, f)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            assert manager.should_resume("plan-123") is False

    def test_should_resume_false_no_checkpoint(self, tmp_path):
        """Test should_resume returns False when no checkpoint exists."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            assert manager.should_resume("nonexistent") is False


class TestCheckpointManagerList:
    """Tests for CheckpointManager.list method."""

    def test_list_empty(self, tmp_path):
        """Test list returns empty list when no checkpoints."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            result = manager.list()
            
            assert result == []

    def test_list_multiple_checkpoints(self, tmp_path):
        """Test list returns all checkpoints sorted by mtime."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        # Create multiple checkpoint files
        for i, name in enumerate(["plan-a", "plan-b", "plan-c"]):
            filepath = checkpoint_dir / f"{name}.json"
            filepath.touch()
            # Set different modification times
            import time
            time.sleep(0.01)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            result = manager.list()
            
            assert len(result) == 3
            # Should be sorted by modification time descending (newest first)
            plan_ids = [r[0] for r in result]
            assert "plan-c" in plan_ids
            assert "plan-b" in plan_ids
            assert "plan-a" in plan_ids

    def test_list_returns_datetime(self, tmp_path):
        """Test list returns datetime objects."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        filepath = checkpoint_dir / "plan-123.json"
        filepath.touch()
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            result = manager.list()
            
            assert len(result) == 1
            plan_id, mtime = result[0]
            assert plan_id == "plan-123"
            assert isinstance(mtime, datetime)

    def test_list_ignores_non_json_files(self, tmp_path):
        """Test list ignores non-JSON files."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        (checkpoint_dir / "plan-123.json").touch()
        (checkpoint_dir / "not-a-checkpoint.txt").touch()
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            result = manager.list()
            
            assert len(result) == 1
            assert result[0][0] == "plan-123"


class TestCheckpointManagerRoundTrip:
    """Tests for save/load roundtrip."""

    def test_save_load_roundtrip(self, tmp_path):
        """Test save followed by load preserves data."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            original = PlanExecution(
                plan_id="plan-123",
                started_at=datetime(2024, 3, 4, 12, 0, 0),
                completed_at=datetime(2024, 3, 4, 13, 0, 0),
                steps=[
                    StepExecution(
                        step_id="step_1",
                        status="completed",
                        started_at=datetime(2024, 3, 4, 12, 0, 0),
                        completed_at=datetime(2024, 3, 4, 12, 30, 0),
                        duration_seconds=1800.0,
                        retry_count=1,
                        max_retries=5,
                        error_message="Had an error but recovered",
                        files_modified=["a.py", "b.py"],
                        lines_added=50,
                        lines_removed=10,
                        output_summary="Did lots of work",
                    ),
                    StepExecution(
                        step_id="step_2",
                        status="failed",
                        error_message="Failed permanently",
                    ),
                ],
                overall_status="failed",
                current_step_ids=["step_2"],
            )
            
            manager.save(original)
            loaded = manager.load("plan-123")
            
            assert loaded.plan_id == original.plan_id
            assert loaded.started_at == original.started_at
            assert loaded.completed_at == original.completed_at
            assert loaded.overall_status == original.overall_status
            assert loaded.current_step_ids == original.current_step_ids
            assert len(loaded.steps) == len(original.steps)
            
            # Check first step
            assert loaded.steps[0].step_id == "step_1"
            assert loaded.steps[0].status == "completed"
            assert loaded.steps[0].started_at == original.steps[0].started_at
            assert loaded.steps[0].completed_at == original.steps[0].completed_at
            assert loaded.steps[0].duration_seconds == 1800.0
            assert loaded.steps[0].retry_count == 1
            assert loaded.steps[0].max_retries == 5
            assert loaded.steps[0].error_message == "Had an error but recovered"
            assert loaded.steps[0].files_modified == ["a.py", "b.py"]
            assert loaded.steps[0].lines_added == 50
            assert loaded.steps[0].lines_removed == 10
            assert loaded.steps[0].output_summary == "Did lots of work"
            
            # Check second step
            assert loaded.steps[1].step_id == "step_2"
            assert loaded.steps[1].status == "failed"
            assert loaded.steps[1].error_message == "Failed permanently"

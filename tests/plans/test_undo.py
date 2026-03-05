"""Tests for the execution history (undo) module."""

import pytest
import tempfile
import os
from pathlib import Path

from kimi_cli.plans.undo import (
    ExecutionHistory,
    FileSnapshot,
    StepSnapshot,
    get_execution_history,
)


class TestFileSnapshot:
    """Test the FileSnapshot dataclass."""
    
    def test_file_snapshot_creation(self):
        """Test creating a file snapshot."""
        snap = FileSnapshot(
            path="/tmp/test.py",
            content="print('hello')",
            exists=True,
        )
        assert snap.path == "/tmp/test.py"
        assert snap.content == "print('hello')"
        assert snap.exists is True
    
    def test_file_snapshot_nonexistent(self):
        """Test snapshot for non-existent file."""
        snap = FileSnapshot(
            path="/tmp/nonexistent.py",
            content=None,
            exists=False,
        )
        assert snap.path == "/tmp/nonexistent.py"
        assert snap.content is None
        assert snap.exists is False


class TestStepSnapshot:
    """Test the StepSnapshot dataclass."""
    
    def test_step_snapshot_creation(self):
        """Test creating a step snapshot."""
        from datetime import datetime
        
        snap = StepSnapshot(
            step_number=1,
            timestamp=datetime.now(),
            file_snapshots=[],
            description="Test step",
        )
        assert snap.step_number == 1
        assert snap.description == "Test step"


class TestExecutionHistory:
    """Test the ExecutionHistory class."""
    
    def test_empty_history(self):
        """Test empty history."""
        history = ExecutionHistory()
        
        assert not history.can_undo()
        assert not history.can_redo()
        assert history.get_history() == []
        assert history.undo() is None
    
    def test_snapshot_single_file(self):
        """Test taking a snapshot of a single file."""
        history = ExecutionHistory()
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write('original content')
            temp_path = f.name
        
        try:
            history.snapshot(1, [temp_path], 'Test step')
            
            assert history.can_undo()
            assert len(history.get_history()) == 1
            assert history.get_history()[0]['step'] == 1
            assert history.get_history()[0]['description'] == 'Test step'
        finally:
            os.unlink(temp_path)
    
    def test_undo_restores_file(self):
        """Test that undo restores file content."""
        history = ExecutionHistory()
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write('original content')
            temp_path = f.name
        
        try:
            # Take snapshot
            history.snapshot(1, [temp_path], 'Test step')
            
            # Modify file
            with open(temp_path, 'w') as f:
                f.write('modified content')
            
            # Verify modification
            with open(temp_path) as f:
                assert f.read() == 'modified content'
            
            # Undo
            desc = history.undo()
            
            # Verify restoration
            assert desc == 'Test step'
            with open(temp_path) as f:
                assert f.read() == 'original content'
        finally:
            os.unlink(temp_path)
    
    def test_undo_deletes_created_file(self):
        """Test that undo deletes a file that didn't exist before."""
        history = ExecutionHistory()
        
        temp_path = tempfile.mktemp(suffix='.txt')
        
        # Ensure file doesn't exist
        assert not Path(temp_path).exists()
        
        # Take snapshot (file doesn't exist)
        history.snapshot(1, [temp_path], 'Create file step')
        
        # Create file
        with open(temp_path, 'w') as f:
            f.write('new content')
        
        assert Path(temp_path).exists()
        
        try:
            # Undo should delete the file
            history.undo()
            
            assert not Path(temp_path).exists()
        finally:
            if Path(temp_path).exists():
                os.unlink(temp_path)
    
    def test_multiple_snapshots(self):
        """Test taking multiple snapshots."""
        history = ExecutionHistory()
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write('content 1')
            temp_path = f.name
        
        try:
            history.snapshot(1, [temp_path], 'Step 1')
            
            with open(temp_path, 'w') as f:
                f.write('content 2')
            history.snapshot(2, [temp_path], 'Step 2')
            
            with open(temp_path, 'w') as f:
                f.write('content 3')
            history.snapshot(3, [temp_path], 'Step 3')
            
            assert len(history.get_history()) == 3
            
            # Undo in reverse order
            assert history.undo() == 'Step 3'
            with open(temp_path) as f:
                assert f.read() == 'content 2'
            
            assert history.undo() == 'Step 2'
            with open(temp_path) as f:
                assert f.read() == 'content 1'
        finally:
            os.unlink(temp_path)
    
    def test_max_history_limit(self):
        """Test that max_history limits the number of snapshots."""
        history = ExecutionHistory(max_history=3)
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write('content')
            temp_path = f.name
        
        try:
            # Take 5 snapshots
            for i in range(5):
                with open(temp_path, 'w') as f:
                    f.write(f'content {i}')
                history.snapshot(i, [temp_path], f'Step {i}')
            
            # Should only keep 3 (the most recent)
            assert len(history.get_history()) == 3
        finally:
            os.unlink(temp_path)
    
    def test_redo_placeholder(self):
        """Test that redo returns None (placeholder implementation)."""
        history = ExecutionHistory()
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write('content')
            temp_path = f.name
        
        try:
            history.snapshot(1, [temp_path], 'Step')
            history.undo()
            
            # Redo is not fully implemented
            assert history.redo() is None
        finally:
            os.unlink(temp_path)
    
    def test_snapshot_clears_redo_stack(self):
        """Test that taking a new snapshot clears the redo stack."""
        history = ExecutionHistory()
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write('content')
            temp_path = f.name
        
        try:
            history.snapshot(1, [temp_path], 'Step 1')
            history.undo()
            
            # After undo, something is in redo stack
            assert len(history._redo_stack) == 1
            
            # New snapshot clears redo
            history.snapshot(2, [temp_path], 'Step 2')
            assert len(history._redo_stack) == 0
        finally:
            os.unlink(temp_path)
    
    def test_clear_history(self):
        """Test clearing history."""
        history = ExecutionHistory()
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write('content')
            temp_path = f.name
        
        try:
            history.snapshot(1, [temp_path], 'Step')
            assert history.can_undo()
            
            history.clear()
            
            assert not history.can_undo()
            assert not history.can_redo()
            assert len(history.get_history()) == 0
        finally:
            os.unlink(temp_path)
    
    def test_multiple_files_in_snapshot(self):
        """Test snapshot with multiple files."""
        history = ExecutionHistory()
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f1:
            f1.write('file1 original')
            path1 = f1.name
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f2:
            f2.write('file2 original')
            path2 = f2.name
        
        try:
            history.snapshot(1, [path1, path2], 'Multi-file step')
            
            # Modify both files
            with open(path1, 'w') as f:
                f.write('file1 modified')
            with open(path2, 'w') as f:
                f.write('file2 modified')
            
            # Undo both
            history.undo()
            
            with open(path1) as f:
                assert f.read() == 'file1 original'
            with open(path2) as f:
                assert f.read() == 'file2 original'
        finally:
            os.unlink(path1)
            os.unlink(path2)


class TestGetExecutionHistory:
    """Test the global get_execution_history function."""
    
    def test_global_history_instance(self):
        """Test that get_execution_history returns the same instance."""
        history1 = get_execution_history()
        history2 = get_execution_history()
        
        assert history1 is history2
        assert isinstance(history1, ExecutionHistory)

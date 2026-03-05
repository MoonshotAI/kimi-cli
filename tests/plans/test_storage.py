"""Tests for plans.storage module."""

import pytest
import json
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from kimi_cli.plans.storage import PlanStorage
from kimi_cli.plans.models import Plan, PlanOption


class TestPlanStorageInit:
    """Tests for PlanStorage initialization."""

    def test_init_creates_directory(self, tmp_path):
        """Test initialization creates plans directory."""
        with patch.object(PlanStorage, 'DIR', tmp_path / ".kimi" / "plans"):
            storage = PlanStorage()
            assert storage.DIR.exists()

    def test_init_existing_directory(self, tmp_path):
        """Test initialization with existing directory."""
        plans_dir = tmp_path / ".kimi" / "plans"
        plans_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            assert storage.DIR.exists()


class TestPlanStorageSave:
    """Tests for PlanStorage.save method."""

    def test_save_creates_file(self, tmp_path):
        """Test save creates plan file."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            plan = Plan(
                id="test-id",
                query="Add authentication",
                options=[
                    PlanOption(
                        id=1,
                        title="Quick",
                        description="Fast",
                        pros=["Fast"],
                        cons=["Debt"],
                        estimated_time="15 min",
                        approach_type="quick",
                    ),
                    PlanOption(
                        id=2,
                        title="Proper",
                        description="Good",
                        pros=["Good"],
                        cons=["Slow"],
                        estimated_time="2 hours",
                        approach_type="proper",
                    ),
                ],
                created_at=datetime(2024, 3, 4, 12, 0, 0),
                context_snapshot={"key": "value"},
            )
            
            plan_id = storage.save(plan)
            
            assert plan_id.startswith("20240304_120000_")
            filepath = plans_dir / f"{plan_id}.json"
            assert filepath.exists()

    def test_save_serializes_correctly(self, tmp_path):
        """Test save serializes plan correctly."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            plan = Plan(
                id="plan-123",
                query="Add user login",
                options=[
                    PlanOption(
                        id=1,
                        title="Quick Fix",
                        description="Fast solution",
                        pros=["Fast", "Simple"],
                        cons=["Technical debt"],
                        estimated_time="30 min",
                        approach_type="quick",
                    ),
                ],
                created_at=datetime(2024, 3, 4, 12, 30, 45),
                context_snapshot={"files": ["auth.py"]},
            )
            
            storage.save(plan)
            
            # Find the saved file
            files = list(plans_dir.glob("*.json"))
            assert len(files) == 1
            
            with open(files[0]) as f:
                data = json.load(f)
            
            assert data["id"] == "plan-123"
            assert data["query"] == "Add user login"
            assert data["created_at"] == "2024-03-04T12:30:45"
            assert data["context_snapshot"] == {"files": ["auth.py"]}
            assert len(data["options"]) == 1
            assert data["options"][0]["id"] == 1
            assert data["options"][0]["title"] == "Quick Fix"
            assert data["options"][0]["approach_type"] == "quick"

    def test_save_generates_slug(self, tmp_path):
        """Test save generates proper slug from query."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            plan = Plan(
                id="test",
                query="Add user authentication feature",
                options=[],
                created_at=datetime(2024, 3, 4, 12, 0, 0),
                context_snapshot={},
            )
            
            plan_id = storage.save(plan)
            
            assert "add_user_authentication_feature" in plan_id


class TestPlanStorageLoad:
    """Tests for PlanStorage.load method."""

    def test_load_existing_plan(self, tmp_path):
        """Test loading existing plan."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        plan_data = {
            "id": "plan-123",
            "query": "Add authentication",
            "created_at": "2024-03-04T12:00:00",
            "context_snapshot": {"work_dir": "/tmp"},
            "options": [
                {
                    "id": 1,
                    "title": "Quick",
                    "description": "Fast",
                    "pros": ["Fast"],
                    "cons": ["Debt"],
                    "estimated_time": "15 min",
                    "approach_type": "quick",
                }
            ]
        }
        
        filepath = plans_dir / "test_plan.json"
        with open(filepath, 'w') as f:
            json.dump(plan_data, f)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            plan = storage.load("test_plan")
            
            assert plan is not None
            assert plan.id == "plan-123"
            assert plan.query == "Add authentication"
            assert plan.created_at == datetime(2024, 3, 4, 12, 0, 0)
            assert plan.context_snapshot == {"work_dir": "/tmp"}
            assert len(plan.options) == 1
            assert plan.options[0].title == "Quick"

    def test_load_nonexistent_plan(self, tmp_path):
        """Test loading non-existent plan returns None."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            plan = storage.load("nonexistent")
            
            assert plan is None

    def test_load_corrupted_json(self, tmp_path):
        """Test loading corrupted JSON returns None."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        filepath = plans_dir / "corrupted.json"
        with open(filepath, 'w') as f:
            f.write("not valid json")
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            plan = storage.load("corrupted")
            
            assert plan is None

    def test_load_missing_required_fields(self, tmp_path):
        """Test loading JSON with missing required fields returns None."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        filepath = plans_dir / "incomplete.json"
        with open(filepath, 'w') as f:
            json.dump({"id": "plan-123"}, f)  # Missing query, created_at, etc.
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            plan = storage.load("incomplete")
            
            assert plan is None


class TestPlanStorageList:
    """Tests for PlanStorage.list method."""

    def test_list_empty(self, tmp_path):
        """Test list returns empty list when no plans."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            result = storage.list()
            
            assert result == []

    def test_list_multiple_plans(self, tmp_path):
        """Test list returns all plans sorted by date."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        # Create multiple plan files
        for i, (query, created_at) in enumerate([
            ("First plan", "2024-03-04T10:00:00"),
            ("Second plan", "2024-03-04T12:00:00"),
            ("Third plan", "2024-03-04T11:00:00"),
        ]):
            plan_data = {
                "id": f"plan-{i}",
                "query": query,
                "created_at": created_at,
                "context_snapshot": {},
                "options": []
            }
            filepath = plans_dir / f"plan_{i}.json"
            with open(filepath, 'w') as f:
                json.dump(plan_data, f)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            result = storage.list()
            
            assert len(result) == 3
            # Should be sorted by created_at descending
            queries = [r[1] for r in result]
            assert queries == ["Second plan", "Third plan", "First plan"]

    def test_list_returns_correct_types(self, tmp_path):
        """Test list returns correct data types."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        plan_data = {
            "id": "plan-123",
            "query": "Test plan",
            "created_at": "2024-03-04T12:00:00",
            "context_snapshot": {},
            "options": []
        }
        
        filepath = plans_dir / "test_plan.json"
        with open(filepath, 'w') as f:
            json.dump(plan_data, f)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            result = storage.list()
            
            assert len(result) == 1
            plan_id, query, created_at = result[0]
            assert plan_id == "test_plan"
            assert query == "Test plan"
            assert isinstance(created_at, datetime)
            assert created_at == datetime(2024, 3, 4, 12, 0, 0)

    def test_list_skips_corrupted_files(self, tmp_path):
        """Test list skips corrupted files (invalid JSON)."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        # Valid file
        with open(plans_dir / "valid.json", 'w') as f:
            json.dump({
                "id": "plan-1",
                "query": "Valid",
                "created_at": "2024-03-04T12:00:00",
                "context_snapshot": {},
                "options": []
            }, f)
        
        # Corrupted file (invalid JSON)
        with open(plans_dir / "corrupted.json", 'w') as f:
            f.write("not json")
        
        # Incomplete but valid JSON (uses defaults)
        with open(plans_dir / "incomplete.json", 'w') as f:
            json.dump({"id": "plan-2"}, f)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            result = storage.list()
            
            # Should have 2 entries (valid and incomplete), corrupted is skipped
            assert len(result) == 2
            plan_ids = [r[0] for r in result]
            assert "valid" in plan_ids
            assert "incomplete" in plan_ids
            assert "corrupted" not in plan_ids

    def test_list_unknown_query_for_missing_field(self, tmp_path):
        """Test list uses 'Unknown' for missing query field."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        # File with missing query but valid otherwise
        with open(plans_dir / "no_query.json", 'w') as f:
            json.dump({
                "id": "plan-1",
                "created_at": "2024-03-04T12:00:00",
                "context_snapshot": {},
                "options": []
            }, f)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            result = storage.list()
            
            assert len(result) == 1
            assert result[0][1] == "Unknown"


class TestPlanStorageDelete:
    """Tests for PlanStorage.delete method."""

    def test_delete_existing(self, tmp_path):
        """Test delete removes existing plan."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        filepath = plans_dir / "plan_to_delete.json"
        filepath.touch()
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            result = storage.delete("plan_to_delete")
            
            assert result is True
            assert not filepath.exists()

    def test_delete_nonexistent(self, tmp_path):
        """Test delete returns False for non-existent plan."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            result = storage.delete("nonexistent")
            
            assert result is False


class TestPlanStorageGetLast:
    """Tests for PlanStorage.get_last method."""

    def test_get_last_existing(self, tmp_path):
        """Test get_last returns most recent plan."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        import time
        
        # Create older file
        with open(plans_dir / "older.json", 'w') as f:
            json.dump({
                "id": "older",
                "query": "Older plan",
                "created_at": "2024-03-04T10:00:00",
                "context_snapshot": {},
                "options": []
            }, f)
        time.sleep(0.01)
        
        # Create newer file
        with open(plans_dir / "newer.json", 'w') as f:
            json.dump({
                "id": "newer",
                "query": "Newer plan",
                "created_at": "2024-03-04T12:00:00",
                "context_snapshot": {},
                "options": []
            }, f)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            plan = storage.get_last()
            
            assert plan is not None
            assert plan.query == "Newer plan"

    def test_get_last_no_plans(self, tmp_path):
        """Test get_last returns None when no plans."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            plan = storage.get_last()
            
            assert plan is None


class TestPlanStorageSlugify:
    """Tests for PlanStorage._slugify method."""

    def test_slugify_simple(self):
        """Test slugify with simple text."""
        storage = PlanStorage()
        
        result = storage._slugify("Add authentication")
        
        assert result == "add_authentication"

    def test_slugify_with_special_chars(self):
        """Test slugify removes special characters."""
        storage = PlanStorage()
        
        result = storage._slugify("Fix bug #123: auth system!")
        
        assert result == "fix_bug_123_auth_system"

    def test_slugify_with_multiple_spaces(self):
        """Test slugify handles multiple spaces."""
        storage = PlanStorage()
        
        result = storage._slugify("Refactor   the    code")
        
        assert result == "refactor_the_code"

    def test_slugify_with_dashes(self):
        """Test slugify converts dashes to underscores."""
        storage = PlanStorage()
        
        result = storage._slugify("some-feature-request")
        
        assert result == "some_feature_request"

    def test_slugify_truncates_long_text(self):
        """Test slugify truncates to 50 chars."""
        storage = PlanStorage()
        
        long_text = "a" * 100
        result = storage._slugify(long_text)
        
        assert len(result) == 50

    def test_slugify_removes_trailing_underscores(self):
        """Test slugify removes trailing underscores."""
        storage = PlanStorage()
        
        result = storage._slugify("test query! ")
        
        assert not result.endswith("_")

    def test_slugify_empty_result_defaults_to_plan(self):
        """Test slugify returns 'plan' for empty result."""
        storage = PlanStorage()
        
        result = storage._slugify("!@#$%")
        
        assert result == "plan"

    def test_slugify_lowercase(self):
        """Test slugify converts to lowercase."""
        storage = PlanStorage()
        
        result = storage._slugify("UPPER CASE TEXT")
        
        assert result == "upper_case_text"


class TestPlanStorageRoundTrip:
    """Tests for save/load roundtrip."""

    def test_save_load_roundtrip(self, tmp_path):
        """Test save followed by load preserves data."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            original = Plan(
                id="plan-abc-123",
                query="Implement user management system",
                options=[
                    PlanOption(
                        id=1,
                        title="Quick and Dirty",
                        description="Just get it working",
                        pros=["Fast deployment", "Immediate results"],
                        cons=["Technical debt", "Hard to maintain"],
                        estimated_time="2 hours",
                        approach_type="quick",
                    ),
                    PlanOption(
                        id=2,
                        title="Full Implementation",
                        description="Complete solution with tests",
                        pros=["Production ready", "Well tested", "Maintainable"],
                        cons=["Takes longer", "More complex"],
                        estimated_time="2 days",
                        approach_type="proper",
                    ),
                    PlanOption(
                        id=3,
                        title="Hybrid Approach",
                        description="Quick start with gradual improvement",
                        pros=[["Balanced", "Iterative"]],
                        cons=[["Requires planning"]],
                        estimated_time="1 day",
                        approach_type="hybrid",
                    ),
                ],
                created_at=datetime(2024, 3, 4, 14, 30, 0),
                context_snapshot={
                    "work_dir": "/home/user/project",
                    "files": ["models.py", "views.py", "auth.py"],
                    "patterns": ["mvc", "repository"],
                },
            )
            
            plan_id = storage.save(original)
            loaded = storage.load(plan_id)
            
            assert loaded.id == original.id
            assert loaded.query == original.query
            assert loaded.created_at == original.created_at
            assert loaded.context_snapshot == original.context_snapshot
            assert len(loaded.options) == len(original.options)
            
            for i, (orig_opt, loaded_opt) in enumerate(zip(original.options, loaded.options)):
                assert loaded_opt.id == orig_opt.id
                assert loaded_opt.title == orig_opt.title
                assert loaded_opt.description == orig_opt.description
                assert loaded_opt.pros == orig_opt.pros
                assert loaded_opt.cons == orig_opt.cons
                assert loaded_opt.estimated_time == orig_opt.estimated_time
                assert loaded_opt.approach_type == orig_opt.approach_type

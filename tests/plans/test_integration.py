"""Integration tests for the Plans System."""

import pytest
import json
import asyncio
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from kimi_cli.plans.models import Plan, PlanOption, PlanStep, PlanExecution, StepExecution
from kimi_cli.plans.detector import ComplexityDetector
from kimi_cli.plans.generator import PlanGenerator, PlanGenerationError
from kimi_cli.plans.executor import PlanExecutor, ExecutionAborted
from kimi_cli.plans.checkpoint import CheckpointManager
from kimi_cli.plans.storage import PlanStorage


class TestFullPlanFlow:
    """Integration tests for full plan workflows."""

    @pytest.mark.asyncio
    async def test_generate_save_load_flow(self, tmp_path):
        """Test complete flow: generate plan → save → load."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        # Mock LLM response
        mock_llm = MagicMock()
        mock_llm.chat_provider = MagicMock()
        
        mock_result = MagicMock()
        mock_content = MagicMock()
        mock_content.text = json.dumps({
            "options": [
                {
                    "id": 1,
                    "title": "Quick Fix",
                    "description": "Fast solution",
                    "pros": ["Fast"],
                    "cons": ["Debt"],
                    "estimated_time": "15 min",
                    "approach_type": "quick",
                },
                {
                    "id": 2,
                    "title": "Proper Solution",
                    "description": "Complete solution",
                    "pros": ["Good"],
                    "cons": ["Slow"],
                    "estimated_time": "2 hours",
                    "approach_type": "proper",
                },
            ]
        })
        mock_result.message.content = [mock_content]
        
        with patch("kimi_cli.plans.generator.kosong.step", new_callable=AsyncMock) as mock_step:
            mock_step.return_value = mock_result
            
            with patch.object(PlanStorage, 'DIR', plans_dir):
                # 1. Generate plan
                generator = PlanGenerator(llm=mock_llm)
                plan = await generator.generate(
                    user_request="Add authentication",
                    work_dir="/tmp/project",
                    files=["auth.py"],
                )
                
                assert isinstance(plan, Plan)
                assert len(plan.options) == 2
                
                # 2. Save plan
                storage = PlanStorage()
                plan_id = storage.save(plan)
                
                # 3. Load plan
                loaded_plan = storage.load(plan_id)
                
                assert loaded_plan is not None
                assert loaded_plan.query == plan.query
                assert len(loaded_plan.options) == len(plan.options)
                assert loaded_plan.options[0].title == plan.options[0].title

    def test_complex_plan_execution_order(self):
        """Test complex plan with dependencies executes in correct order."""
        # Create a complex plan with multiple waves of dependencies
        steps = [
            # Wave 1: Independent steps
            PlanStep(id="analyze", name="Analyze", description="Analyze code", depends_on=[]),
            PlanStep(id="research", name="Research", description="Research solutions", depends_on=[]),
            
            # Wave 2: Depends on analyze
            PlanStep(id="design", name="Design", description="Design solution", depends_on=["analyze"]),
            
            # Wave 3: Depends on design
            PlanStep(id="implement_core", name="Implement Core", description="Core implementation", depends_on=["design"]),
            PlanStep(id="setup_tests", name="Setup Tests", description="Setup test framework", depends_on=["design"]),
            
            # Wave 4: Depends on multiple previous steps
            PlanStep(id="write_tests", name="Write Tests", description="Write tests", depends_on=["setup_tests", "implement_core"]),
            
            # Wave 5: Depends on research and write_tests
            PlanStep(id="docs", name="Documentation", description="Write docs", depends_on=["research", "write_tests"]),
        ]
        
        plan = Plan(
            id="complex-plan",
            query="Implement feature",
            options=[],
            created_at=datetime.now(),
            context_snapshot={},
            steps=steps,
        )
        
        waves = plan.get_execution_order()
        
        # Verify waves
        assert len(waves) == 5
        
        # Wave 1: analyze, research (no dependencies)
        assert set(waves[0]) == {"analyze", "research"}
        
        # Wave 2: design (depends on analyze)
        assert waves[1] == ["design"]
        
        # Wave 3: implement_core, setup_tests (both depend on design)
        assert set(waves[2]) == {"implement_core", "setup_tests"}
        
        # Wave 4: write_tests (depends on setup_tests and implement_core)
        assert waves[3] == ["write_tests"]
        
        # Wave 5: docs (depends on research and write_tests)
        assert waves[4] == ["docs"]

    def test_checkpoint_resume_flow(self, tmp_path):
        """Test execution with checkpoint resume."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            # Create an execution that's partially complete
            execution = PlanExecution(
                plan_id="test-plan",
                started_at=datetime(2024, 3, 4, 12, 0, 0),
                steps=[
                    StepExecution(
                        step_id="step_1",
                        status="completed",
                        started_at=datetime(2024, 3, 4, 12, 0, 0),
                        completed_at=datetime(2024, 3, 4, 12, 10, 0),
                        output_summary="Step 1 done",
                    ),
                    StepExecution(
                        step_id="step_2",
                        status="running",
                        started_at=datetime(2024, 3, 4, 12, 10, 0),
                    ),
                    StepExecution(
                        step_id="step_3",
                        status="pending",
                    ),
                ],
                overall_status="running",
                current_step_ids=["step_2"],
            )
            
            # Save checkpoint
            manager.save(execution)
            
            # Verify checkpoint exists and should_resume returns True
            assert manager.exists("test-plan") is True
            assert manager.should_resume("test-plan") is True
            
            # Load checkpoint
            loaded = manager.load("test-plan")
            
            assert loaded is not None
            assert loaded.plan_id == "test-plan"
            assert loaded.overall_status == "running"
            assert len(loaded.steps) == 3
            assert loaded.steps[0].status == "completed"
            assert loaded.steps[1].status == "running"
            assert loaded.steps[2].status == "pending"
            
            # Complete the execution
            loaded.steps[1].status = "completed"
            loaded.steps[1].completed_at = datetime(2024, 3, 4, 12, 20, 0)
            loaded.steps[2].status = "completed"
            loaded.steps[2].completed_at = datetime(2024, 3, 4, 12, 30, 0)
            loaded.overall_status = "completed"
            
            manager.save(loaded)
            
            # Now should_resume should return False
            assert manager.should_resume("test-plan") is False


class TestComplexityDetectionIntegration:
    """Integration tests for complexity detection with various scenarios."""

    def test_simple_request_no_planning_needed(self):
        """Test that simple requests don't trigger planning."""
        detector = ComplexityDetector()
        
        simple_requests = [
            ("fix typo", []),
            ("update comment", ["file.py"]),
            ("rename variable", ["script.py"]),
            ("add print statement", ["debug.py"]),
        ]
        
        for request, files in simple_requests:
            score = detector.analyze(request, files, [])
            assert score.should_plan is False, f"'{request}' should not require planning"

    def test_complex_request_triggers_planning(self):
        """Test that complex requests trigger planning."""
        detector = ComplexityDetector()
        
        complex_requests = [
            ("refactor authentication system", ["auth.py", "models.py", "views.py", "tests.py"]),  # 30 + 20 + 20 = 70
            ("redesign the database schema with auth", ["models.py", "migrations/001.py", "migrations/002.py", "migrations/003.py", "migrations/004.py"]),  # 30 + 20 + 20 = 70
            ("create a plan for new feature", ["a.py", "b.py", "c.py", "d.py", "e.py"]),  # 30 + 40 = 70
            ("migrate to new architecture", ["src/a.py", "src/b.py", "src/c.py", "src/d.py"]),  # 30 + 20 + 20 = 70
        ]
        
        for request, files in complex_requests:
            score = detector.analyze(request, files, [])
            assert score.should_plan is True, f"'{request}' should require planning (score: {score.total})"

    def test_cross_module_detection(self):
        """Test cross-module detection with realistic file structures."""
        detector = ComplexityDetector()
        
        # Single module (same directory)
        single_module_files = [
            "src/models.py",
            "src/views.py",
            "src/utils.py",
        ]
        score = detector.analyze("update code", single_module_files, [])
        assert "cross_module" not in score.factors
        
        # Cross module (different directories)
        cross_module_files = [
            "src/models.py",
            "tests/test_models.py",
            "docs/models.md",
        ]
        score = detector.analyze("update code", cross_module_files, [])
        assert "cross_module" in score.factors

    def test_security_keywords_comprehensive(self):
        """Test all security-related keywords."""
        detector = ComplexityDetector()
        
        security_requests = [
            "fix security vulnerability",
            "update auth mechanism",
            "implement authentication",
            "add authorization checks",
            "encrypt passwords",
        ]
        
        for request in security_requests:
            score = detector.analyze(request, [], [])
            assert "security" in score.factors, f"'{request}' should trigger security factor"
            assert score.factors["security"] == 20


class TestPlanStorageIntegration:
    """Integration tests for plan storage operations."""

    def test_storage_workflow(self, tmp_path):
        """Test complete storage workflow."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            # Create and save multiple plans
            plans = []
            for i in range(3):
                plan = Plan(
                    id=f"plan-{i}",
                    query=f"Task {i}",
                    options=[
                        PlanOption(
                            id=1,
                            title=f"Option for {i}",
                            description="Description",
                            pros=[],
                            cons=[],
                            estimated_time=None,
                            approach_type="quick",
                        ),
                    ],
                    created_at=datetime(2024, 3, 4, 12, i, 0),
                    context_snapshot={},
                )
                plan_id = storage.save(plan)
                plans.append((plan_id, plan))
            
            # List should return all plans
            listed = storage.list()
            assert len(listed) == 3
            
            # Load each plan and verify
            for plan_id, original in plans:
                loaded = storage.load(plan_id)
                assert loaded is not None
                assert loaded.query == original.query
            
            # Get last should return the most recently modified
            last = storage.get_last()
            # Last saved plan
            assert last is not None
            
            # Delete one plan
            deleted_id = plans[0][0]
            result = storage.delete(deleted_id)
            assert result is True
            
            # Verify deletion
            assert storage.load(deleted_id) is None
            
            # List should now have 2 plans
            listed = storage.list()
            assert len(listed) == 2


class TestExecutorListenerIntegration:
    """Integration tests for executor event listeners."""

    @pytest.mark.asyncio
    async def test_listener_events_fired(self, sample_plan):
        """Test that all listener events are fired correctly."""
        mock_llm = MagicMock()
        executor = PlanExecutor(llm=mock_llm, enable_checkpoints=False)
        
        events = []
        
        def on_step_start(step_exec):
            events.append(("start", step_exec.step_id))
        
        def on_step_complete(step_exec):
            events.append(("complete", step_exec.step_id))
        
        executor.add_listener("step_start", on_step_start)
        executor.add_listener("step_complete", on_step_complete)
        
        # Create execution with one step
        execution = PlanExecution(
            plan_id=sample_plan.id,
            started_at=datetime.now(),
            steps=[],
        )
        
        # Mock step runner
        with patch.object(executor._step_runner, 'run', new_callable=AsyncMock) as mock_run:
            mock_run.return_value = {
                "summary": "Done",
                "files": [],
                "lines_added": 0,
                "lines_removed": 0,
            }
            
            await executor._execute_step(sample_plan, execution, "step_1")
        
        # Verify events were fired
        assert ("start", "step_1") in events
        assert ("complete", "step_1") in events


class TestErrorHandlingIntegration:
    """Integration tests for error handling scenarios."""

    @pytest.mark.asyncio
    async def test_generator_handles_llm_failure(self):
        """Test generator handles LLM failure gracefully."""
        mock_llm = MagicMock()
        
        with patch("kimi_cli.plans.generator.kosong.step", new_callable=AsyncMock) as mock_step:
            mock_step.side_effect = Exception("Network error")
            
            generator = PlanGenerator(llm=mock_llm)
            
            with pytest.raises(PlanGenerationError, match="LLM call failed"):
                await generator.generate("test request")

    def test_storage_handles_corrupted_files(self, tmp_path):
        """Test storage handles corrupted files gracefully."""
        plans_dir = tmp_path / "plans"
        plans_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            storage = PlanStorage()
            
            # Create corrupted file
            (plans_dir / "corrupted.json").write_text("not valid json")
            
            # Create valid file
            with open(plans_dir / "valid.json", 'w') as f:
                json.dump({
                    "id": "plan-1",
                    "query": "Valid",
                    "created_at": "2024-03-04T12:00:00",
                    "context_snapshot": {},
                    "options": []
                }, f)
            
            # Load corrupted should return None
            assert storage.load("corrupted") is None
            
            # List should skip corrupted but include valid
            listed = storage.list()
            assert len(listed) == 1
            assert listed[0][0] == "valid"
            
            # get_last should return valid
            last = storage.get_last()
            assert last is not None
            assert last.query == "Valid"

    def test_checkpoint_handles_missing_file(self, tmp_path):
        """Test checkpoint handles missing file gracefully."""
        checkpoint_dir = tmp_path / "checkpoints"
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
            manager = CheckpointManager()
            
            # Operations on non-existent checkpoint
            assert manager.load("nonexistent") is None
            assert manager.exists("nonexistent") is False
            assert manager.should_resume("nonexistent") is False
            assert manager.delete("nonexistent") is False


class TestEndToEndScenarios:
    """End-to-end scenario tests."""

    def test_full_plan_lifecycle(self, tmp_path):
        """Test complete plan lifecycle from detection to execution tracking."""
        plans_dir = tmp_path / "plans"
        checkpoint_dir = tmp_path / "checkpoints"
        plans_dir.mkdir(parents=True)
        checkpoint_dir.mkdir(parents=True)
        
        with patch.object(PlanStorage, 'DIR', plans_dir):
            with patch.object(CheckpointManager, 'DIR', checkpoint_dir):
                # 1. User requests a complex feature
                user_request = "refactor the authentication system"
                predicted_files = ["auth.py", "models.py", "views.py", "tests.py"]
                
                # 2. Complexity detection triggers
                detector = ComplexityDetector()
                score = detector.analyze(user_request, predicted_files, [])
                assert score.should_plan is True, f"Expected planning, got score {score.total}"
                
                # 3. Plan would be generated (mocked)
                # 4. Plan is saved
                sample_steps = [
                    PlanStep(id="analyze", name="Analyze", description="Analyze current code", depends_on=[]),
                    PlanStep(id="design", name="Design", description="Design new structure", depends_on=["analyze"]),
                    PlanStep(id="implement", name="Implement", description="Implement changes", depends_on=["design"]),
                ]
                plan = Plan(
                    id="auth-refactor-plan",
                    query=user_request,
                    options=[
                        PlanOption(
                            id=1,
                            title="Quick Patch",
                            description="Minimal changes",
                            pros=["Fast"],
                            cons=["Debt"],
                            estimated_time="1 hour",
                            approach_type="quick",
                        ),
                        PlanOption(
                            id=2,
                            title="Full Refactor",
                            description="Complete rewrite",
                            pros=["Clean"],
                            cons=["Time"],
                            estimated_time="3 days",
                            approach_type="proper",
                        ),
                    ],
                    created_at=datetime.now(),
                    context_snapshot={"files": predicted_files},
                    steps=sample_steps,
                )
                
                storage = PlanStorage()
                plan_id = storage.save(plan)
                
                # 5. Plan is loaded for execution
                loaded_plan = storage.load(plan_id)
                assert loaded_plan is not None
                
                # 6. Execution tracking
                execution = loaded_plan.to_execution()
                assert execution.plan_id == plan.id
                assert len(execution.steps) == 3
                
                # 7. Checkpoint saved during execution
                checkpoint_mgr = CheckpointManager()
                checkpoint_path = checkpoint_mgr.save(execution)
                assert checkpoint_path.exists()
                
                # 8. Execution can be resumed
                assert checkpoint_mgr.should_resume(plan.id) is True
                
                # 9. Complete execution
                for step in execution.steps:
                    step.status = "completed"
                execution.overall_status = "completed"
                checkpoint_mgr.save(execution)
                
                # 10. No longer needs resume
                assert checkpoint_mgr.should_resume(plan.id) is False
                
                # 11. Cleanup
                storage.delete(plan_id)
                checkpoint_mgr.delete(plan.id)
                
                assert storage.load(plan_id) is None
                assert not checkpoint_mgr.exists(plan.id)

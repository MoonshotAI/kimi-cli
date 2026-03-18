"""Unit tests for inspect_plan_edit_target."""

from __future__ import annotations

from pathlib import Path

from kaos.path import KaosPath
from kosong.tooling import ToolError

from kimi_cli.tools.file.plan_mode import PlanEditTarget, inspect_plan_edit_target


class TestInspectPlanEditTarget:
    def test_plan_mode_inactive_when_checker_is_none(self, tmp_path: Path) -> None:
        target = tmp_path / "file.txt"
        result = inspect_plan_edit_target(
            KaosPath(str(target)).canonical(),
            plan_mode_checker=None,
            plan_file_path_getter=None,
        )
        assert isinstance(result, PlanEditTarget)
        assert not result.active
        assert not result.is_plan_target

    def test_plan_mode_inactive_when_checker_returns_false(self, tmp_path: Path) -> None:
        target = tmp_path / "file.txt"
        result = inspect_plan_edit_target(
            KaosPath(str(target)).canonical(),
            plan_mode_checker=lambda: False,
            plan_file_path_getter=lambda: tmp_path / "plan.md",
        )
        assert isinstance(result, PlanEditTarget)
        assert not result.active
        assert not result.is_plan_target

    def test_plan_path_unavailable(self, tmp_path: Path) -> None:
        target = tmp_path / "file.txt"
        result = inspect_plan_edit_target(
            KaosPath(str(target)).canonical(),
            plan_mode_checker=lambda: True,
            plan_file_path_getter=lambda: None,
        )
        assert isinstance(result, ToolError)
        assert "unavailable" in result.message

    def test_path_matches_plan_file(self, tmp_path: Path) -> None:
        plan_path = tmp_path / "plan.md"
        result = inspect_plan_edit_target(
            KaosPath(str(plan_path)).canonical(),
            plan_mode_checker=lambda: True,
            plan_file_path_getter=lambda: plan_path,
        )
        assert isinstance(result, PlanEditTarget)
        assert result.active
        assert result.is_plan_target
        assert result.plan_path == plan_path

    def test_path_does_not_match_plan_file(self, tmp_path: Path) -> None:
        plan_path = tmp_path / "plan.md"
        other_path = tmp_path / "other.txt"
        result = inspect_plan_edit_target(
            KaosPath(str(other_path)).canonical(),
            plan_mode_checker=lambda: True,
            plan_file_path_getter=lambda: plan_path,
        )
        assert isinstance(result, ToolError)
        assert "only edit the current plan file" in result.message

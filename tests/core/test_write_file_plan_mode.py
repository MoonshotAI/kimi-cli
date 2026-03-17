"""Tests for WriteFile plan mode integration.

Verifies that plan mode allows writing to the plan file (auto-approved)
while other write operations still go through normal approval.
Plan mode constraints on Shell are enforced by the dynamic injection prompt,
not by hard-blocking the tool — Shell remains usable through user approval.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock

from kaos.path import KaosPath
from kosong.tooling import ToolReturnValue

from kimi_cli.soul.agent import Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.tools.file.write import Params, WriteFile
from kimi_cli.tools.shell import Params as ShellParams
from kimi_cli.tools.shell import Shell
from kimi_cli.tools.utils import ToolRejectedError
from kimi_cli.utils.environment import Environment
from tests.conftest import tool_call_context


class TestWriteFilePlanMode:
    async def test_plan_file_auto_approved(
        self, runtime: Runtime, temp_work_dir: KaosPath, tmp_path: Path
    ) -> None:
        """Writing to the plan file should bypass approval even with yolo=False."""
        approval = Approval(yolo=False)
        with tool_call_context("WriteFile"):
            tool = WriteFile(runtime, approval)
            plan_path = tmp_path / "plans" / "test-plan.md"
            tool.bind_plan_mode(
                checker=lambda: True,
                path_getter=lambda: plan_path,
            )

            # Mock approval.request to fail if called — plan file should skip it
            request_mock = AsyncMock(return_value=False)
            approval.request = cast(Any, request_mock)

            result = await tool(
                Params(
                    path=str(plan_path),
                    content="# My Plan",
                )
            )

        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert plan_path.exists()
        assert plan_path.read_text() == "# My Plan"
        # Approval should NOT have been called for plan file
        request_mock.assert_not_awaited()

    async def test_non_plan_file_needs_approval_in_plan_mode(
        self, runtime: Runtime, temp_work_dir: KaosPath
    ) -> None:
        """Non-plan files in plan mode still require approval (rejected when not approved)."""
        approval = Approval(yolo=False)
        target = temp_work_dir / "other.txt"
        plan_path = Path(str(temp_work_dir)) / "plans" / "plan.md"
        with tool_call_context("WriteFile"):
            tool = WriteFile(runtime, approval)
            tool.bind_plan_mode(
                checker=lambda: True,
                path_getter=lambda: plan_path,
            )

            # Mock approval.request to return False (rejected)
            request_mock = AsyncMock(return_value=False)
            approval.request = cast(Any, request_mock)

            result = await tool(
                Params(
                    path=str(target),
                    content="hello",
                )
            )

        assert isinstance(result, ToolRejectedError)
        # Approval WAS called for non-plan file
        request_mock.assert_awaited_once()

    async def test_no_plan_mode_normal_flow(
        self, runtime: Runtime, temp_work_dir: KaosPath
    ) -> None:
        """Without plan mode binding, yolo=True auto-approves normally."""
        approval = Approval(yolo=True)
        target = temp_work_dir / "normal.txt"
        with tool_call_context("WriteFile"):
            tool = WriteFile(runtime, approval)
            result = await tool(
                Params(
                    path=str(target),
                    content="hello",
                )
            )

        assert isinstance(result, ToolReturnValue)
        assert not result.is_error

    async def test_plan_file_creates_parent_dir(
        self, runtime: Runtime, temp_work_dir: KaosPath, tmp_path: Path
    ) -> None:
        """Plan file writes should auto-create parent directories."""
        approval = Approval(yolo=False)
        plan_path = tmp_path / "deep" / "nested" / "plan.md"
        with tool_call_context("WriteFile"):
            tool = WriteFile(runtime, approval)
            tool.bind_plan_mode(
                checker=lambda: True,
                path_getter=lambda: plan_path,
            )

            result = await tool(
                Params(
                    path=str(plan_path),
                    content="# Deep Plan",
                )
            )

        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert plan_path.exists()
        assert plan_path.read_text() == "# Deep Plan"

    async def test_plan_file_write_works_with_session_plan_mode_active(
        self, runtime: Runtime, temp_work_dir: KaosPath, tmp_path: Path
    ) -> None:
        """Plan file writing must work when session.state.plan_mode is True.

        This is the realistic scenario: KimiSoul sets session.state.plan_mode = True
        AND binds WriteFile with plan_mode checker.  WriteFile plan file writes
        must be auto-approved without going through the approval dialog.
        """
        runtime.session.state.plan_mode = True
        approval = Approval(yolo=False)
        plan_path = tmp_path / "plans" / "session-plan.md"
        with tool_call_context("WriteFile"):
            tool = WriteFile(runtime, approval)
            tool.bind_plan_mode(
                checker=lambda: runtime.session.state.plan_mode,
                path_getter=lambda: plan_path,
            )

            # Mock approval to reject — plan file should bypass it
            request_mock = AsyncMock(return_value=False)
            approval.request = cast(Any, request_mock)

            result = await tool(
                Params(path=str(plan_path), content="# Implementation Plan\n\n## Steps\n1. ...")
            )

        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert plan_path.exists()
        assert plan_path.read_text().startswith("# Implementation Plan")
        request_mock.assert_not_awaited()

    async def test_plan_file_append_works_in_plan_mode(
        self, runtime: Runtime, temp_work_dir: KaosPath, tmp_path: Path
    ) -> None:
        """Appending to the plan file should also be auto-approved in plan mode."""
        runtime.session.state.plan_mode = True
        approval = Approval(yolo=False)
        plan_path = tmp_path / "plans" / "append-plan.md"
        plan_path.parent.mkdir(parents=True, exist_ok=True)
        plan_path.write_text("# Plan v1\n")
        with tool_call_context("WriteFile"):
            tool = WriteFile(runtime, approval)
            tool.bind_plan_mode(
                checker=lambda: runtime.session.state.plan_mode,
                path_getter=lambda: plan_path,
            )

            request_mock = AsyncMock(return_value=False)
            approval.request = cast(Any, request_mock)

            result = await tool(
                Params(path=str(plan_path), content="\n## New Section\n", mode="append")
            )

        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert "# Plan v1" in plan_path.read_text()
        assert "## New Section" in plan_path.read_text()
        request_mock.assert_not_awaited()


class TestPlanModeToolContract:
    """Verify the plan mode tool contract:

    - Shell is NOT hard-blocked; plan mode constraints are enforced via dynamic
      injection prompts and user approval, not at the tool layer.
    - WriteFile auto-approves plan file writes, bypassing user approval.
    - Both Shell and WriteFile (plan file) work in the same plan mode session.
    """

    async def test_shell_still_works_in_plan_mode(
        self,
        runtime: Runtime,
        environment: Environment,
    ) -> None:
        """Shell must not be hard-blocked in plan mode.

        Plan mode read-only guidance is delivered via PlanModeInjectionProvider.
        The tool itself remains usable through normal approval flow.
        """
        runtime.session.state.plan_mode = True
        approval = Approval(yolo=True)

        with tool_call_context("Shell"):
            shell = Shell(approval, environment, runtime)
            result = await shell(ShellParams(command="echo plan_shell_ok"))

        assert not result.is_error
        assert "plan_shell_ok" in result.output

    async def test_shell_and_plan_file_write_both_work_in_plan_mode(
        self,
        runtime: Runtime,
        environment: Environment,
        temp_work_dir: KaosPath,
        tmp_path: Path,
    ) -> None:
        """In the same plan mode session, both Shell and WriteFile plan writes must succeed."""
        runtime.session.state.plan_mode = True
        plan_path = tmp_path / "plans" / "combined-plan.md"

        # Shell works (through yolo approval)
        with tool_call_context("Shell"):
            shell = Shell(Approval(yolo=True), environment, runtime)
            shell_result = await shell(ShellParams(command="echo shell_ok"))

        assert not shell_result.is_error
        assert "shell_ok" in shell_result.output

        # WriteFile to plan file works (auto-approved, no approval needed)
        approval = Approval(yolo=False)
        with tool_call_context("WriteFile"):
            write_tool = WriteFile(runtime, approval)
            write_tool.bind_plan_mode(
                checker=lambda: runtime.session.state.plan_mode,
                path_getter=lambda: plan_path,
            )
            request_mock = AsyncMock(return_value=False)
            approval.request = cast(Any, request_mock)

            write_result = await write_tool(
                Params(path=str(plan_path), content="# Plan\n\nBoth tools work in plan mode.")
            )

        assert isinstance(write_result, ToolReturnValue)
        assert not write_result.is_error
        assert plan_path.exists()
        request_mock.assert_not_awaited()

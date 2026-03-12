"""Tests for WriteFile plan mode integration."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock

from kaos.path import KaosPath
from kosong.tooling import ToolReturnValue

from kimi_cli.soul.agent import Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.tools.file.write import Params, WriteFile
from kimi_cli.tools.utils import ToolRejectedError
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

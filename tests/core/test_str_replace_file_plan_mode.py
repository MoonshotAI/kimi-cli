"""Tests for StrReplaceFile plan mode integration."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast
from unittest.mock import AsyncMock

from kaos.path import KaosPath
from kosong.tooling import ToolError, ToolReturnValue

from kimi_cli.soul.agent import Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.tools.file.replace import Edit, Params, StrReplaceFile
from tests.conftest import tool_call_context


class TestStrReplaceFilePlanMode:
    async def test_plan_file_auto_approved(
        self, runtime: Runtime, temp_work_dir: KaosPath, tmp_path: Path
    ) -> None:
        """Editing the plan file should bypass approval even with yolo=False."""
        approval = Approval(yolo=False)
        plan_path = tmp_path / "plans" / "test-plan.md"
        plan_path.parent.mkdir(parents=True, exist_ok=True)
        plan_path.write_text("# Plan\n- old", encoding="utf-8")

        with tool_call_context("StrReplaceFile"):
            tool = StrReplaceFile(runtime, approval)
            tool.bind_plan_mode(
                checker=lambda: True,
                path_getter=lambda: plan_path,
            )

            request_mock = AsyncMock(return_value=False)
            approval.request = cast(Any, request_mock)

            result = await tool(
                Params(
                    path=str(plan_path),
                    edit=Edit(old="- old", new="- new"),
                )
            )

        assert isinstance(result, ToolReturnValue)
        assert not result.is_error
        assert plan_path.read_text() == "# Plan\n- new"
        request_mock.assert_not_awaited()

    async def test_non_plan_file_is_blocked_in_plan_mode(
        self, runtime: Runtime, temp_work_dir: KaosPath
    ) -> None:
        """Plan mode should hard-block replacements on non-plan files."""
        approval = Approval(yolo=False)
        target = temp_work_dir / "other.txt"
        await target.write_text("old")
        plan_path = Path(str(temp_work_dir)) / "plans" / "plan.md"

        with tool_call_context("StrReplaceFile"):
            tool = StrReplaceFile(runtime, approval)
            tool.bind_plan_mode(
                checker=lambda: True,
                path_getter=lambda: plan_path,
            )

            request_mock = AsyncMock(return_value=False)
            approval.request = cast(Any, request_mock)

            result = await tool(
                Params(
                    path=str(target),
                    edit=Edit(old="old", new="new"),
                )
            )

        assert isinstance(result, ToolError)
        assert "only edit the current plan file" in result.message
        request_mock.assert_not_awaited()

    async def test_missing_plan_file_guides_to_write_file(
        self, runtime: Runtime, tmp_path: Path
    ) -> None:
        approval = Approval(yolo=False)
        plan_path = tmp_path / "plans" / "missing-plan.md"

        with tool_call_context("StrReplaceFile"):
            tool = StrReplaceFile(runtime, approval)
            tool.bind_plan_mode(
                checker=lambda: True,
                path_getter=lambda: plan_path,
            )

            result = await tool(
                Params(
                    path=str(plan_path),
                    edit=Edit(old="old", new="new"),
                )
            )

        assert isinstance(result, ToolError)
        assert "Use WriteFile to create it" in result.message

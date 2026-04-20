from collections.abc import Callable
from pathlib import Path
from typing import override

from kaos.path import KaosPath
from kosong.tooling import CallableTool2, ToolError, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.soul.agent import Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.tools.display import DisplayBlock
from kimi_cli.tools.file import FileActions
from kimi_cli.tools.file.plan_mode import inspect_plan_edit_target
from kimi_cli.tools.utils import load_desc
from kimi_cli.utils.diff import build_diff_blocks
from kimi_cli.utils.logging import logger
from kimi_cli.utils.path import is_within_workspace

_BASE_DESCRIPTION = load_desc(Path(__file__).parent / "replace.md")


class Edit(BaseModel):
    old: str = Field(description="The old string to replace. Can be multi-line.")
    new: str = Field(description="The new string to replace with. Can be multi-line.")
    replace_all: bool = Field(description="Whether to replace all occurrences.", default=False)


class Params(BaseModel):
    path: str = Field(
        description=(
            "The path to the file to edit. Absolute paths are required when editing files "
            "outside the working directory."
        )
    )
    edit: Edit | list[Edit] = Field(
        description=(
            "The edit(s) to apply to the file. "
            "You can provide a single edit or a list of edits here."
        )
    )


class StrReplaceFile(CallableTool2[Params]):
    name: str = "StrReplaceFile"
    description: str = _BASE_DESCRIPTION
    params: type[Params] = Params

    def __init__(self, runtime: Runtime, approval: Approval):
        super().__init__()
        self._work_dir = runtime.builtin_args.KIMI_WORK_DIR
        self._additional_dirs = runtime.additional_dirs
        self._approval = approval
        self._plan_mode_checker: Callable[[], bool] | None = None
        self._plan_file_path_getter: Callable[[], Path | None] | None = None

    def bind_plan_mode(
        self, checker: Callable[[], bool], path_getter: Callable[[], Path | None]
    ) -> None:
        """Bind plan mode state checker and plan file path getter."""
        self._plan_mode_checker = checker
        self._plan_file_path_getter = path_getter

    async def _validate_path(self, path: KaosPath) -> ToolError | None:
        """Validate that the path is safe to edit."""
        resolved_path = path.canonical()

        if (
            not is_within_workspace(resolved_path, self._work_dir, self._additional_dirs)
            and not path.is_absolute()
        ):
            return ToolError(
                message=(
                    f"`{path}` is not an absolute path. "
                    "You must provide an absolute path to edit a file "
                    "outside the working directory."
                ),
                brief="Invalid path",
            )
        return None

    def _apply_edit(self, content: str, edit: Edit) -> str:
        """Apply a single edit to the content."""
        if edit.replace_all:
            return content.replace(edit.old, edit.new)
        else:
            return content.replace(edit.old, edit.new, 1)

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        if not params.path:
            return ToolError(
                message="File path cannot be empty.",
                brief="Empty file path",
            )

        try:
            p = KaosPath(params.path).expanduser()
            if err := await self._validate_path(p):
                return err
            p = p.canonical()

            plan_target = inspect_plan_edit_target(
                p,
                plan_mode_checker=self._plan_mode_checker,
                plan_file_path_getter=self._plan_file_path_getter,
            )
            if isinstance(plan_target, ToolError):
                return plan_target

            is_plan_file_edit = plan_target.is_plan_target

            if not await p.exists():
                if is_plan_file_edit:
                    return ToolError(
                        message=(
                            "The current plan file does not exist yet. "
                            "Use WriteFile to create it before calling StrReplaceFile."
                        ),
                        brief="Plan file not created",
                    )
                return ToolError(
                    message=f"`{params.path}` does not exist.",
                    brief="File not found",
                )
            if not await p.is_file():
                return ToolError(
                    message=f"`{params.path}` is not a file.",
                    brief="Invalid path",
                )

            # Read the file content
            content = await p.read_text(errors="replace", newline="")

            original_content = content
            edits = [params.edit] if isinstance(params.edit, Edit) else params.edit

            # Apply all edits
            for edit in edits:
                content = self._apply_edit(content, edit)

            # Check if any changes were made
            if content == original_content:
                return ToolError(
                    message="No replacements were made. The old string was not found in the file.",
                    brief="No replacements made",
                )

            diff_blocks: list[DisplayBlock] = await build_diff_blocks(
                str(p), original_content, content
            )

            action = (
                FileActions.EDIT
                if is_within_workspace(p, self._work_dir, self._additional_dirs)
                else FileActions.EDIT_OUTSIDE
            )

            # Plan file edits are auto-approved; all other edits need approval.
            if not is_plan_file_edit:
                result = await self._approval.request(
                    self.name,
                    action,
                    f"Edit file `{p}`",
                    display=diff_blocks,
                )
                if not result:
                    return result.rejection_error()

            # Write the modified content back to the file
            await p.write_text(content, errors="replace")

            # Count changes for success message
            total_replacements = 0
            for edit in edits:
                if edit.replace_all:
                    total_replacements += original_content.count(edit.old)
                else:
                    total_replacements += 1 if edit.old in original_content else 0

            return ToolReturnValue(
                is_error=False,
                output="",
                message=(
                    f"File successfully edited. "
                    f"Applied {len(edits)} edit(s) with {total_replacements} total replacement(s)."
                ),
                display=diff_blocks,
            )

        except Exception as e:
            logger.warning("StrReplaceFile failed: {path}: {error}", path=params.path, error=e)
            return ToolError(
                message=f"Failed to edit. Error: {e}",
                brief="Failed to edit file",
            )

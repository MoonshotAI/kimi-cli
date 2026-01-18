from pathlib import Path
from typing import override

from kaos.path import KaosPath
from kosong.tooling import CallableTool2, ToolError, ToolReturnValue
from pydantic import BaseModel, Field

from kimi_cli.soul.agent import BuiltinSystemPromptArgs
from kimi_cli.soul.approval import Approval
from kimi_cli.tools.display import DisplayBlock
from kimi_cli.tools.file import FileActions
from kimi_cli.tools.utils import ToolRejectedError, load_desc
from kimi_cli.utils.diff import build_diff_blocks
from kimi_cli.utils.path import is_within_directory


class Edit(BaseModel):
    old: str = Field(description="The old string to replace. Can be multi-line.")
    new: str = Field(description="The new string to replace with. Can be multi-line.")
    replace_all: bool = Field(description="Whether to replace all occurrences.", default=False)


class Params(BaseModel):
    path: str = Field(description="The absolute path to the file to edit.")
    edit: Edit | list[Edit] = Field(
        description=(
            "The edit(s) to apply to the file. "
            "You can provide a single edit or a list of edits here."
        )
    )


class StrReplaceFile(CallableTool2[Params]):
    name: str = "StrReplaceFile"
    description: str = load_desc(Path(__file__).parent / "replace.md")
    params: type[Params] = Params

    def __init__(self, builtin_args: BuiltinSystemPromptArgs, approval: Approval):
        super().__init__()
        self._work_dir = builtin_args.KIMI_WORK_DIR
        self._approval = approval

    async def _validate_path(self, path: KaosPath) -> ToolError | None:
        """Validate that the path is safe to edit."""
        # Check for path traversal attempts
        resolved_path = path.canonical()

        # Ensure the path is within work directory
        if not is_within_directory(resolved_path, self._work_dir):
            return ToolError(
                message=(
                    f"`{path}` is outside the working directory. "
                    "You can only edit files within the working directory."
                ),
                brief="Path outside working directory",
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
        try:
            p = KaosPath(params.path)

            if not p.is_absolute():
                return ToolError(
                    message=(
                        f"`{params.path}` is not an absolute path. "
                        "You must provide an absolute path to edit a file."
                    ),
                    brief="Invalid path",
                )

            # Validate path safety
            path_error = await self._validate_path(p)
            if path_error:
                return path_error

            if not await p.exists():
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
            content = await p.read_text(errors="replace")

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

            diff_blocks: list[DisplayBlock] = list(
                build_diff_blocks(params.path, original_content, content)
            )

            # Request approval
            if not await self._approval.request(
                self.name,
                FileActions.EDIT,
                f"Edit file `{params.path}`",
                display=diff_blocks,
            ):
                return ToolRejectedError()

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
            return ToolError(
                message=f"Failed to edit. Error: {e}",
                brief="Failed to edit file",
            )

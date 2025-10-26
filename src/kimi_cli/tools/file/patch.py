from pathlib import Path
from typing import override

import aiofiles
import patch_ng
from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnType
from pydantic import BaseModel, Field

from kimi_cli.soul.approval import Approval
from kimi_cli.soul.globals import BuiltinSystemPromptArgs
from kimi_cli.tools.file import FileActions
from kimi_cli.tools.utils import ToolRejectedError


class Params(BaseModel):
    path: str = Field(description="The absolute path to the file to apply the patch to.")
    diff: str = Field(description="The diff content in unified format to apply.")


class PatchFile(CallableTool2[Params]):
    name: str = "PatchFile"
    description: str = (Path(__file__).parent / "patch.md").read_text(encoding="utf-8")
    params: type[Params] = Params

    def __init__(self, builtin_args: BuiltinSystemPromptArgs, approval: Approval, **kwargs):
        super().__init__(**kwargs)
        self._work_dir = builtin_args.KIMI_WORK_DIR
        self._approval = approval

    def _validate_path(self, path: Path) -> ToolError | None:
        """Validate that the path is safe to patch."""
        # Check for path traversal attempts
        resolved_path = path.resolve()
        resolved_work_dir = Path(self._work_dir).resolve()

        # Ensure the path is within work directory
        if not str(resolved_path).startswith(str(resolved_work_dir)):
            return ToolError(
                message=(
                    f"`{path}` is outside the working directory. "
                    "You can only patch files within the working directory."
                ),
                brief="Path outside working directory",
            )
        return None

    @override
    async def __call__(self, params: Params) -> ToolReturnType:
        try:
            p = Path(params.path)

            if not p.is_absolute():
                return ToolError(
                    message=(
                        f"`{params.path}` is not an absolute path. "
                        "You must provide an absolute path to patch a file."
                    ),
                    brief="Invalid path",
                )

            # Validate path safety
            path_error = self._validate_path(p)
            if path_error:
                return path_error

            if not p.exists():
                return ToolError(
                    message=f"`{params.path}` does not exist.",
                    brief="File not found",
                )
            if not p.is_file():
                return ToolError(
                    message=f"`{params.path}` is not a file.",
                    brief="Invalid path",
                )

            # Request approval
            if not await self._approval.request(
                self.name,
                FileActions.EDIT,
                f"Patch file `{params.path}`",
            ):
                return ToolRejectedError()

            # Read the file content
            async with aiofiles.open(p, encoding="utf-8", errors="replace") as f:
                original_content = await f.read()

            # Create patch object directly from string (no temporary file needed!)
            patch_set = patch_ng.fromstring(params.diff.encode("utf-8"))

            # Handle case where patch_ng.fromstring returns False on parse errors
            if not patch_set or patch_set is True:
                return ToolError(
                    message=(
                        "Failed to parse diff content: invalid patch format or no valid hunks found"
                    ),
                    brief="Invalid diff format",
                )

            # Count total hunks across all items
            total_hunks = sum(len(item.hunks) for item in patch_set.items)

            if total_hunks == 0:
                return ToolError(
                    message="No valid hunks found in the diff content",
                    brief="No hunks found",
                )

            # Apply the patch
            success = patch_set.apply(root=str(p.parent))

            if not success:
                return ToolError(
                    message=(
                        "Failed to apply patch - patch may not be compatible with the file content"
                    ),
                    brief="Patch application failed",
                )

            # Read the modified content to check if changes were made
            async with aiofiles.open(p, encoding="utf-8", errors="replace") as f:
                modified_content = await f.read()

            # Check if any changes were made
            if modified_content == original_content:
                return ToolError(
                    message="No changes were made. The patch does not apply to the file.",
                    brief="No changes made",
                )

            return ToolOk(
                output="",
                message=(
                    f"File successfully patched. Applied {total_hunks} hunk(s) to {params.path}."
                ),
            )

        except Exception as e:
            return ToolError(
                message=f"Failed to patch file. Error: {e}",
                brief="Failed to patch file",
            )

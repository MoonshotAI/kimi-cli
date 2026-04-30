from collections.abc import Callable
from pathlib import Path
from typing import Literal, override

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
from kimi_cli.utils.path import is_within_directory, is_within_workspace

_BASE_DESCRIPTION = load_desc(Path(__file__).parent / "write.md")


class Params(BaseModel):
    path: str = Field(
        description=(
            "The path to the file to write. Absolute paths are required when writing files "
            "outside the working directory."
        )
    )
    content: str = Field(description="The content to write to the file")
    mode: Literal["overwrite", "append"] = Field(
        description=(
            "The mode to use to write to the file. "
            "Two modes are supported: `overwrite` for overwriting the whole file and "
            "`append` for appending to the end of an existing file."
        ),
        default="overwrite",
    )


class WriteFile(CallableTool2[Params]):
    name: str = "WriteFile"
    description: str = _BASE_DESCRIPTION
    params: type[Params] = Params

    def __init__(self, runtime: Runtime, approval: Approval):
        super().__init__()
        self._work_dir = runtime.builtin_args.KIMI_WORK_DIR
        self._additional_dirs = runtime.additional_dirs
        self._approval = approval
        self._auto_approve_dirs = runtime.config.auto_approve_workspace_dirs or []
        self._plan_mode_checker: Callable[[], bool] | None = None
        self._plan_file_path_getter: Callable[[], Path | None] | None = None

    def bind_plan_mode(
        self, checker: Callable[[], bool], path_getter: Callable[[], Path | None]
    ) -> None:
        """Bind plan mode state checker and plan file path getter."""
        self._plan_mode_checker = checker
        self._plan_file_path_getter = path_getter

    def _is_auto_approved_dir(self, path: KaosPath) -> bool:
        """Check if path is within a configured auto-approve workspace directory."""
        if not self._auto_approve_dirs:
            return False
        for dir_name in self._auto_approve_dirs:
            # Reject absolute paths to prevent bypassing workspace boundaries;
            # auto-approve dirs must be relative to work_dir.
            if KaosPath(dir_name).is_absolute():
                logger.warning("Ignoring absolute auto_approve_workspace_dir: {dir}", dir=dir_name)
                continue
            resolved = (self._work_dir / dir_name).canonical()
            # Reject entries that resolve to the workspace root itself.
            if resolved == self._work_dir:
                logger.warning(
                    "Ignoring auto_approve_workspace_dir that resolves to workspace root: {dir}",
                    dir=dir_name,
                )
                continue
            # Reject entries that escape work_dir via ".." traversal.
            if not is_within_directory(resolved, self._work_dir):
                logger.warning(
                    "Ignoring auto_approve_workspace_dir that escapes workspace: {dir}",
                    dir=dir_name,
                )
                continue
            if is_within_directory(path, resolved):
                return True
        return False

    async def _validate_path(self, path: KaosPath) -> ToolError | None:
        """Validate that the path is safe to write."""
        resolved_path = path.canonical()

        if (
            not is_within_workspace(resolved_path, self._work_dir, self._additional_dirs)
            and not path.is_absolute()
        ):
            return ToolError(
                message=(
                    f"`{path}` is not an absolute path. "
                    "You must provide an absolute path to write a file "
                    "outside the working directory."
                ),
                brief="Invalid path",
            )
        return None

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        # TODO: checks:
        # - check if the path may contain secrets
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

            is_plan_file_write = plan_target.is_plan_target
            if is_plan_file_write and plan_target.plan_path is not None:
                plan_target.plan_path.parent.mkdir(parents=True, exist_ok=True)

            if not await p.parent.exists():
                return ToolError(
                    message=f"`{params.path}` parent directory does not exist.",
                    brief="Parent directory not found",
                )

            # Validate mode parameter
            if params.mode not in ["overwrite", "append"]:
                return ToolError(
                    message=(
                        f"Invalid write mode: `{params.mode}`. "
                        "Mode must be either `overwrite` or `append`."
                    ),
                    brief="Invalid write mode",
                )

            file_existed = await p.exists()
            old_text = None
            if file_existed:
                old_text = await p.read_text(errors="replace")

            new_text = (
                params.content if params.mode == "overwrite" else (old_text or "") + params.content
            )
            diff_blocks: list[DisplayBlock] = await build_diff_blocks(
                str(p),
                old_text or "",
                new_text,
            )

            # Plan file writes and auto-approved dirs are skipped; other writes need approval
            if not is_plan_file_write and not self._is_auto_approved_dir(p):
                action = (
                    FileActions.EDIT
                    if is_within_workspace(p, self._work_dir, self._additional_dirs)
                    else FileActions.EDIT_OUTSIDE
                )

                # Request approval
                result = await self._approval.request(
                    self.name,
                    action,
                    f"Write file `{p}`",
                    display=diff_blocks,
                )
                if not result:
                    return result.rejection_error()

            # Write content to file
            match params.mode:
                case "overwrite":
                    await p.write_text(params.content)
                case "append":
                    await p.append_text(params.content)

            # Get file info for success message
            file_size = (await p.stat()).st_size
            action = "overwritten" if params.mode == "overwrite" else "appended to"
            return ToolReturnValue(
                is_error=False,
                output="",
                message=(f"File successfully {action}. Current size: {file_size} bytes."),
                display=diff_blocks,
            )

        except Exception as e:
            logger.warning("WriteFile failed: {path}: {error}", path=params.path, error=e)
            return ToolError(
                message=f"Failed to write to {params.path}. Error: {e}",
                brief="Failed to write file",
            )

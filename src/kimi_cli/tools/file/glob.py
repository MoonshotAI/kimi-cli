"""Glob tool implementation."""

import asyncio
from pathlib import Path
from typing import Any, override

from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnType
from pydantic import BaseModel, Field

from kimi_cli.soul.runtime import BuiltinSystemPromptArgs
from kimi_cli.tools.utils import load_desc
from kimi_cli.utils.path import list_directory

MAX_MATCHES = 1000


class Params(BaseModel):
    pattern: str = Field(description=("Glob pattern to match files/directories."))
    directory: str | None = Field(
        description=(
            "Absolute path to the directory to search in (defaults to working directory)."
        ),
        default=None,
    )
    include_dirs: bool = Field(
        description="Whether to include directories in results.",
        default=True,
    )


class Glob(CallableTool2[Params]):
    name: str = "Glob"
    description: str = load_desc(
        Path(__file__).parent / "glob.md",
        {
            "MAX_MATCHES": str(MAX_MATCHES),
        },
    )
    params: type[Params] = Params

    def __init__(self, builtin_args: BuiltinSystemPromptArgs, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._work_dir = builtin_args.KIMI_WORK_DIR

    async def _validate_pattern(self, pattern: str) -> ToolError | None:
        """Validate that the pattern is safe to use."""
        if pattern.startswith("**"):
            ls_result = await asyncio.to_thread(list_directory, self._work_dir)
            return ToolError(
                output=ls_result,
                message=(
                    f"Pattern `{pattern}` starts with '**' which is not allowed. "
                    "This would recursively search all directories and may include large "
                    "directories like `node_modules`. Use more specific patterns instead. "
                    "For your convenience, a list of all files and directories in the "
                    "top level of the working directory is provided below."
                ),
                brief="Unsafe pattern",
            )
        return None

    def _validate_directory(self, directory: Path) -> ToolError | None:
        """Validate that the directory is safe to search."""
        resolved_dir = directory.resolve()
        resolved_work_dir = self._work_dir.resolve()

        # Ensure the directory is within work directory
        if not str(resolved_dir).startswith(str(resolved_work_dir)):
            return ToolError(
                message=(
                    f"`{directory}` is outside the working directory. "
                    "You can only search within the working directory."
                ),
                brief="Directory outside working directory",
            )
        return None

    @override
    async def __call__(self, params: Params) -> ToolReturnType:
        try:
            # Validate pattern safety
            pattern_error = await self._validate_pattern(params.pattern)
            if pattern_error:
                return pattern_error

            dir_path = Path(params.directory) if params.directory else self._work_dir

            if not dir_path.is_absolute():
                return ToolError(
                    message=(
                        f"`{params.directory}` is not an absolute path. "
                        "You must provide an absolute path to search."
                    ),
                    brief="Invalid directory",
                )

            # Validate directory safety
            dir_error = self._validate_directory(dir_path)
            if dir_error:
                return dir_error

            if not dir_path.exists():
                return ToolError(
                    message=f"`{params.directory}` does not exist.",
                    brief="Directory not found",
                )
            if not dir_path.is_dir():
                return ToolError(
                    message=f"`{params.directory}` is not a directory.",
                    brief="Invalid directory",
                )

            def _glob(pattern: str) -> list[Path]:
                return list(dir_path.glob(pattern))

            # Perform the glob search - users can use ** directly in pattern
            matches = await asyncio.to_thread(_glob, params.pattern)

            # Filter out directories if not requested
            if not params.include_dirs:
                matches = [p for p in matches if p.is_file()]

            # Sort for consistent output
            matches.sort()

            # Limit matches
            message = (
                f"Found {len(matches)} matches for pattern `{params.pattern}`."
                if len(matches) > 0
                else f"No matches found for pattern `{params.pattern}`."
            )
            if len(matches) > MAX_MATCHES:
                matches = matches[:MAX_MATCHES]
                message += (
                    f" Only the first {MAX_MATCHES} matches are returned. "
                    "You may want to use a more specific pattern."
                )

            return ToolOk(
                output="\n".join(str(p.relative_to(dir_path)) for p in matches),
                message=message,
            )

        except Exception as e:
            return ToolError(
                message=f"Failed to search for pattern {params.pattern}. Error: {e}",
                brief="Glob failed",
            )

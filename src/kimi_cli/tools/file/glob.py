"""Glob tool implementation."""

import fnmatch
from pathlib import Path, PurePosixPath
from typing import override

from kaos.path import KaosPath
from kosong.tooling import CallableTool2, ToolError, ToolOk, ToolReturnValue
from pathspec import PathSpec
from pydantic import BaseModel, Field

from kimi_cli.soul.agent import BuiltinSystemPromptArgs
from kimi_cli.tools.utils import load_desc
from kimi_cli.utils.path import is_within_directory, list_directory

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

    def __init__(self, builtin_args: BuiltinSystemPromptArgs) -> None:
        super().__init__()
        self._work_dir = builtin_args.KIMI_WORK_DIR

    async def _load_gitignore_spec(self) -> PathSpec | None:
        """Return a PathSpec built from the working directory's .gitignore if it exists."""
        gitignore_path = self._work_dir / ".gitignore"
        if not await gitignore_path.is_file():
            return None
        try:
            contents = await gitignore_path.read_text()
        except OSError:
            return None
        return PathSpec.from_lines("gitwildmatch", contents.splitlines())

    def _is_gitignored(self, path: KaosPath, gitignore_spec: PathSpec, is_dir: bool) -> bool:
        """Return True if the path matches the gitignore spec."""
        try:
            relative = path.relative_to(self._work_dir)
            relative_str = str(relative)
        except ValueError:
            relative_str = str(path)
        relative_str = relative_str.replace("\\", "/")
        if is_dir and not relative_str.endswith("/"):
            relative_str += "/"
        return gitignore_spec.match_file(relative_str)

    async def _gitignore_aware_glob(
        self, base_dir: KaosPath, pattern: str, gitignore_spec: PathSpec
    ) -> list[KaosPath]:
        """Glob that prunes gitignored directories instead of filtering after traversal."""
        normalized_pattern = pattern.replace("\\", "/")
        parts = list(PurePosixPath(normalized_pattern).parts)
        if parts and parts[0] == "/":
            parts = parts[1:]

        matches: list[KaosPath] = []

        async def recurse(current: KaosPath, idx: int) -> None:
            if idx == len(parts):
                matches.append(current)
                return

            part = parts[idx]
            if part == "**":
                await recurse(current, idx + 1)

                if not await current.is_dir():
                    return

                async for child in current.iterdir():
                    try:
                        is_dir = await child.is_dir()
                    except OSError:
                        continue

                    if self._is_gitignored(child, gitignore_spec, is_dir):
                        continue

                    if is_dir:
                        await recurse(child, idx)
                    elif idx == len(parts) - 1:
                        matches.append(child)
                return

            if not await current.is_dir():
                return

            async for child in current.iterdir():
                try:
                    is_dir = await child.is_dir()
                except OSError:
                    continue

                if self._is_gitignored(child, gitignore_spec, is_dir):
                    continue

                if fnmatch.fnmatchcase(child.name, part):
                    await recurse(child, idx + 1)

        await recurse(base_dir, 0)
        return matches

    async def _filter_gitignored(
        self, paths: list[KaosPath], gitignore_spec: PathSpec
    ) -> list[KaosPath]:
        """Filter out gitignored paths after a regular glob traversal."""
        filtered: list[KaosPath] = []
        for path in paths:
            try:
                is_dir = await path.is_dir()
            except OSError:
                continue

            if self._is_gitignored(path, gitignore_spec, is_dir):
                continue

            filtered.append(path)
        return filtered

    async def _validate_pattern(self, pattern: str) -> ToolError | None:
        """Validate that the pattern is safe to use."""
        if pattern.startswith("**"):
            gitignore_path = self._work_dir / ".gitignore"
            if await gitignore_path.is_file():
                return None

            ls_result = await list_directory(self._work_dir)
            return ToolError(
                output=ls_result,
                message=(
                    f"Pattern `{pattern}` starts with '**' which is not allowed because "
                    "the working directory does not contain a .gitignore to constrain the search. "
                    "This would recursively search all directories and may include large "
                    "directories like `node_modules`. Use more specific patterns instead. "
                    "For your convenience, a list of all files and directories in the "
                    "top level of the working directory is provided below."
                ),
                brief="Unsafe pattern",
            )
        return None

    async def _validate_directory(self, directory: KaosPath) -> ToolError | None:
        """Validate that the directory is safe to search."""
        resolved_dir = directory.canonical()

        # Ensure the directory is within work directory
        if not is_within_directory(resolved_dir, self._work_dir):
            return ToolError(
                message=(
                    f"`{directory}` is outside the working directory. "
                    "You can only search within the working directory."
                ),
                brief="Directory outside working directory",
            )
        return None

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        try:
            # Validate pattern safety
            pattern_error = await self._validate_pattern(params.pattern)
            if pattern_error:
                return pattern_error

            dir_path = KaosPath(params.directory) if params.directory else self._work_dir

            if not dir_path.is_absolute():
                return ToolError(
                    message=(
                        f"`{params.directory}` is not an absolute path. "
                        "You must provide an absolute path to search."
                    ),
                    brief="Invalid directory",
                )

            # Validate directory safety
            dir_error = await self._validate_directory(dir_path)
            if dir_error:
                return dir_error

            if not await dir_path.exists():
                return ToolError(
                    message=f"`{params.directory}` does not exist.",
                    brief="Directory not found",
                )
            if not await dir_path.is_dir():
                return ToolError(
                    message=f"`{params.directory}` is not a directory.",
                    brief="Invalid directory",
                )

            gitignore_spec = await self._load_gitignore_spec()

            # Perform the glob search - users can use ** directly in pattern
            normalized_pattern = params.pattern.replace("\\", "/")
            if gitignore_spec and normalized_pattern.startswith("**"):
                matches = await self._gitignore_aware_glob(
                    dir_path, normalized_pattern, gitignore_spec
                )
            else:
                matches = [match async for match in dir_path.glob(params.pattern)]
                if gitignore_spec:
                    matches = await self._filter_gitignored(matches, gitignore_spec)

            # Filter out directories if not requested
            if not params.include_dirs:
                matches = [p for p in matches if await p.is_file()]

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

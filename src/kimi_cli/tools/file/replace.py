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
from kimi_cli.utils.path import is_within_workspace, kaos_path_from_user_input

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
        """Apply a single edit to the content (string form; for display/tests)."""
        if edit.replace_all:
            return content.replace(edit.old, edit.new)
        else:
            return content.replace(edit.old, edit.new, 1)

    @staticmethod
    def _detect_line_ending(content: bytes) -> bytes:
        """Return the file's dominant newline bytes (CRLF if any, else LF).

        ReadFile exposes lines with universal newlines, so the model always
        supplies ``\\n`` in multi-line ``old``/``new``. Byte matching must
        re-apply the on-disk ending or CRLF files reject every multi-line edit.
        """
        if b"\r\n" in content:
            return b"\r\n"
        return b"\n"

    @staticmethod
    def _encode_edit_text(text: str, line_ending: bytes) -> bytes:
        """Encode model text as UTF-8 using the file's on-disk newlines."""
        # Model / tool JSON always uses LF; normalize any mixed endings first.
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        encoded = normalized.encode("utf-8")
        if line_ending == b"\r\n":
            return encoded.replace(b"\n", b"\r\n")
        return encoded

    def _apply_edit_bytes(self, content: bytes, edit: Edit) -> bytes:
        """Apply a single edit on raw bytes so non-UTF-8 regions stay intact.

        ``old``/``new`` come from the model as Unicode and are encoded as UTF-8,
        with newlines rewritten to match the file's dominant line ending.
        Searching/replacing in the raw byte stream avoids the
        decode(errors=replace) → edit → re-encode round-trip that permanently
        rewrites invalid sequences (e.g. ``\\xff`` → U+FFFD / ``EF BF BD``)
        far from the requested edit (#2591).
        """
        line_ending = self._detect_line_ending(content)
        old_b = self._encode_edit_text(edit.old, line_ending)
        new_b = self._encode_edit_text(edit.new, line_ending)
        if not old_b:
            return content
        if edit.replace_all:
            return content.replace(old_b, new_b)
        idx = content.find(old_b)
        if idx < 0:
            return content
        return content[:idx] + new_b + content[idx + len(old_b) :]

    @override
    async def __call__(self, params: Params) -> ToolReturnValue:
        if not params.path:
            return ToolError(
                message="File path cannot be empty.",
                brief="Empty file path",
            )

        try:
            p = kaos_path_from_user_input(params.path)
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

            # Read raw bytes so non-UTF-8 sequences outside the edit are preserved
            # (#2591 / same whole-file rewrite class as #2191).
            raw = await p.read_bytes()
            original_raw = raw
            edits = [params.edit] if isinstance(params.edit, Edit) else params.edit

            for edit in edits:
                # Empty old is invalid: str.replace("", ...) is not a meaningful
                # edit, and the byte path intentionally no-ops on empty needles.
                if edit.old == "":
                    return ToolError(
                        message="The old string to replace cannot be empty.",
                        brief="Empty old string",
                    )

            for edit in edits:
                raw = self._apply_edit_bytes(raw, edit)

            if raw == original_raw:
                return ToolError(
                    message="No replacements were made. The old string was not found in the file.",
                    brief="No replacements made",
                )

            # Diff is display-only: lossy decode is fine for the approval UI.
            original_content = original_raw.decode("utf-8", errors="replace")
            content = raw.decode("utf-8", errors="replace")
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

            await p.write_bytes(raw)

            # Count changes for success message (byte-accurate for the edit strings)
            line_ending = self._detect_line_ending(original_raw)
            total_replacements = 0
            for edit in edits:
                old_b = self._encode_edit_text(edit.old, line_ending)
                if not old_b:
                    continue
                if edit.replace_all:
                    total_replacements += original_raw.count(old_b)
                else:
                    total_replacements += 1 if old_b in original_raw else 0

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

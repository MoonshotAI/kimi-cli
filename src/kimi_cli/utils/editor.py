"""External editor utilities for editing text in $VISUAL/$EDITOR."""

from __future__ import annotations

import contextlib
import os
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path

from kimi_cli.utils.logging import logger
from kimi_cli.utils.subprocess_env import get_clean_env

# VSCode needs --wait to block until the file is closed.
_EDITOR_CANDIDATES = [
    (["code", "--wait"], "code"),
    (["vim"], "vim"),
    (["vi"], "vi"),
    (["nano"], "nano"),
]


def get_editor_command(configured: str = "") -> list[str] | None:
    """Determine the editor command to use.

    Priority: *configured* (from config) -> $VISUAL -> $EDITOR -> auto-detect.
    Auto-detect order: code --wait -> vim -> vi -> nano.
    """
    if configured:
        try:
            return shlex.split(configured)
        except ValueError:
            logger.warning("Invalid configured editor value: {}", configured)

    for var in ("VISUAL", "EDITOR"):
        value = os.environ.get(var)
        if value:
            try:
                return shlex.split(value)
            except ValueError:
                logger.warning("Invalid {} value: {}", var, value)
                continue

    for cmd, binary in _EDITOR_CANDIDATES:
        if shutil.which(binary):
            return cmd

    return None


def edit_text_in_editor(text: str, configured: str = "") -> str | None:
    """Open *text* in an external editor and return the edited result.

    Returns ``None`` if the editor failed or the user quit without saving.
    """
    editor_cmd = get_editor_command(configured)
    if editor_cmd is None:
        logger.warning("No editor found. Set $VISUAL or $EDITOR.")
        return None

    fd, tmpfile = tempfile.mkstemp(suffix=".md", prefix="kimi-edit-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)

        mtime_before = os.path.getmtime(tmpfile)

        try:
            returncode = subprocess.call(editor_cmd + [tmpfile], env=get_clean_env())
        except OSError as exc:
            logger.warning("Failed to launch editor {}: {}", editor_cmd, exc)
            return None

        if returncode != 0:
            logger.warning("Editor exited with non-zero return code: {}", returncode)
            return None

        mtime_after = os.path.getmtime(tmpfile)
        if mtime_after == mtime_before:
            return None

        edited = Path(tmpfile).read_text(encoding="utf-8")
        if edited.endswith("\n"):
            edited = edited[:-1]

        return edited
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmpfile)

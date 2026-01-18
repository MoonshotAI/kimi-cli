from __future__ import annotations

import difflib
from difflib import SequenceMatcher

from kimi_cli.tools.display import DiffDisplayBlock

N_CONTEXT_LINES = 3


def format_unified_diff(
    old_text: str,
    new_text: str,
    path: str = "",
    *,
    include_file_header: bool = True,
) -> str:
    """
    Format a unified diff between old_text and new_text.

    Args:
        old_text: The original text.
        new_text: The new text.
        path: Optional file path for the diff header.
        include_file_header: Whether to include the ---/+++ file header lines.

    Returns:
        A unified diff string.
    """
    old_lines = old_text.splitlines(keepends=True)
    new_lines = new_text.splitlines(keepends=True)

    # Ensure lines end with newline for proper diff formatting
    if old_lines and not old_lines[-1].endswith("\n"):
        old_lines[-1] += "\n"
    if new_lines and not new_lines[-1].endswith("\n"):
        new_lines[-1] += "\n"

    fromfile = f"a/{path}" if path else "a/file"
    tofile = f"b/{path}" if path else "b/file"

    diff = list(
        difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile=fromfile,
            tofile=tofile,
            lineterm="\n",
        )
    )

    if (
        not include_file_header
        and len(diff) >= 2
        and diff[0].startswith("--- ")
        and diff[1].startswith("+++ ")
    ):
        diff = diff[2:]

    return "".join(diff)


def build_diff_blocks(
    path: str,
    old_text: str,
    new_text: str,
) -> list[DiffDisplayBlock]:
    """Build diff display blocks grouped with small context windows."""
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    matcher = SequenceMatcher(None, old_lines, new_lines, autojunk=False)
    blocks: list[DiffDisplayBlock] = []
    for group in matcher.get_grouped_opcodes(n=N_CONTEXT_LINES):
        if not group:
            continue
        i1 = group[0][1]
        i2 = group[-1][2]
        j1 = group[0][3]
        j2 = group[-1][4]
        blocks.append(
            DiffDisplayBlock(
                path=path,
                old_text="\n".join(old_lines[i1:i2]),
                new_text="\n".join(new_lines[j1:j2]),
            )
        )
    return blocks

from __future__ import annotations

from difflib import SequenceMatcher

from kimi_cli.tools.display import DiffDisplayBlock

N_CONTEXT_LINES = 3


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

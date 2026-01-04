"""Patch processing utilities."""

from __future__ import annotations

import re


def filter_binary_diffs(patch: str) -> str:
    lines = patch.split("\n")
    result = []
    i = 0

    while i < len(lines):
        line = lines[i]

        if re.match(r"^Binary files .* differ$", line):
            i += 1
            continue

        if line.startswith("diff --git"):
            j = i + 1
            while j < len(lines) and lines[j].startswith("index "):
                j += 1

            if j < len(lines) and re.match(r"^Binary files .* differ$", lines[j]):
                i = j + 1
                continue

        result.append(line)
        i += 1

    return "\n".join(result)


def remove_binary_diffs_from_git(patch: str) -> str:
    blocks = re.split(r"(^diff --git .*$)", patch, flags=re.MULTILINE)

    result_blocks = []
    for i in range(0, len(blocks), 2):
        if i + 1 < len(blocks):
            header = blocks[i]
            content = blocks[i + 1] if i + 1 < len(blocks) else ""

            if not re.search(r"^Binary files .* differ$", content, re.MULTILINE):
                result_blocks.append(header)
                result_blocks.append(content)
        else:
            result_blocks.append(blocks[i])

    return "".join(result_blocks)


def get_changed_files(patch: str) -> list[str]:
    files = []
    for match in re.finditer(r"^diff --git a/(.*) b/\1$", patch, re.MULTILINE):
        files.append(match.group(1))
    return files


def get_patch_stats(patch: str) -> dict[str, int]:
    stats = {
        "files_changed": len(set(re.findall(r"^diff --git", patch, re.MULTILINE))),
        "additions": len(re.findall(r"^\+(?!\+\+)", patch, re.MULTILINE)),
        "deletions": len(re.findall(r"^-(?!--)", patch, re.MULTILINE)),
        "hunks": len(re.findall(r"^@@", patch, re.MULTILINE)),
    }
    return stats


from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import yaml


def parse_frontmatter(text: str) -> dict[str, Any] | None:
    """
    Parse YAML frontmatter from a text blob.

    Raises:
        ValueError: If the frontmatter YAML is invalid.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None

    frontmatter_lines: list[str] = []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        frontmatter_lines.append(line)
    else:
        return None

    frontmatter = "\n".join(frontmatter_lines).strip()
    if not frontmatter:
        return None

    try:
        raw_data: Any = yaml.safe_load(frontmatter)
    except yaml.YAMLError as exc:
        raise ValueError("Invalid frontmatter YAML.") from exc

    if not isinstance(raw_data, dict):
        raise ValueError("Frontmatter YAML must be a mapping.")

    return cast(dict[str, Any], raw_data)


def read_frontmatter(path: Path) -> dict[str, Any] | None:
    """
    Read the YAML frontmatter at the start of a file.

    Args:
        path: Path to an existing file that may contain frontmatter.
    """
    return parse_frontmatter(path.read_text(encoding="utf-8", errors="replace"))


def strip_frontmatter(text: str) -> str:
    """Return *text* with any leading YAML frontmatter block removed.

    Mirrors the detection rule used by :func:`parse_frontmatter`: a frontmatter
    block starts with ``---`` on the first line and ends at the next ``---``
    line. Returns the original text unchanged when no valid frontmatter is
    found. Sharing this helper lets callers skip the frontmatter in exactly the
    same way :func:`parse_frontmatter` does, avoiding duplicate logic.
    """
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "".join(lines[i + 1 :])
    # Malformed frontmatter with no closing ``---``; parse_frontmatter returns
    # None in that case, so we treat the whole input as body.
    return text

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import yaml


def read_frontmatter(path: Path) -> dict[str, Any] | None:
    """
    Read the YAML frontmatter at the start of a file.

    Args:
        path: Path to an existing file that may contain frontmatter.

    Raises:
        ValueError: If the frontmatter YAML is invalid.
    """
    with path.open(encoding="utf-8", errors="replace") as handle:
        first_line = handle.readline()
        if not first_line or first_line.strip() != "---":
            return None

        frontmatter_lines: list[str] = []
        for line in handle:
            if line.strip() == "---":
                break
            frontmatter_lines.append(line)
        else:
            return None

    frontmatter = "".join(frontmatter_lines).strip()
    if not frontmatter:
        return None

    try:
        raw_data: Any = yaml.safe_load(frontmatter)
    except yaml.YAMLError as exc:
        raise ValueError("Invalid frontmatter YAML.") from exc

    if not isinstance(raw_data, dict):
        raise ValueError("Frontmatter YAML must be a mapping.")

    return cast(dict[str, Any], raw_data)

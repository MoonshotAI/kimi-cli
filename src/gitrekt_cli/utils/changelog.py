from __future__ import annotations

from pathlib import Path
from typing import NamedTuple


class ReleaseEntry(NamedTuple):
    description: str
    entries: list[str]


def parse_changelog(md_text: str) -> dict[str, ReleaseEntry]:
    """Parse a subset of Keep a Changelog-style markdown into a map:
    version -> (description, entries)

    Parsing rules:
    - Versions are denoted by level-2 headings starting with '## ['
      Example: `## [v0.10.1] - 2025-09-18` or `## [Unreleased]`
    - For each version section, description is the first contiguous block of
      non-empty lines that do not start with '-' or '#'.
    - Entries are all markdown list items starting with '- ' under that version
      (across any subheadings like '### Added').
    """
    lines = md_text.splitlines()
    result: dict[str, ReleaseEntry] = {}

    current_ver: str | None = None
    collecting_desc = False
    desc_lines: list[str] = []
    bullet_lines: list[str] = []
    seen_content_after_header = False

    def commit():
        nonlocal current_ver, desc_lines, bullet_lines, result
        if current_ver is None:
            return
        description = "\n".join([line.strip() for line in desc_lines]).strip()
        # Deduplicate and normalize entries
        norm_entries = [
            line.strip()[2:].strip() for line in bullet_lines if line.strip().startswith("- ")
        ]
        result[current_ver] = ReleaseEntry(description=description, entries=norm_entries)

    for raw in lines:
        line = raw.rstrip()
        # Format: `## 0.75 (2026-01-09)` or `## Unreleased`
        if line.startswith("## "):
            commit()
            ver = line[3:].strip()
            # Remove trailing date in parentheses if present
            if "(" in ver:
                ver = ver[: ver.find("(")].strip()
            current_ver = ver
            desc_lines = []
            bullet_lines = []
            collecting_desc = True
            seen_content_after_header = False
            continue

        if current_ver is None:
            # Skip until first version section
            continue

        if not line.strip():
            # blank line ends initial description block only after we've seen content
            if collecting_desc and seen_content_after_header:
                collecting_desc = False
            continue

        seen_content_after_header = True

        if line.lstrip().startswith("### "):
            collecting_desc = False
            continue

        if line.lstrip().startswith("- "):
            collecting_desc = False
            bullet_lines.append(line.strip())
            continue

        if collecting_desc:
            # Accumulate description until a blank line or bullets/subheadings
            desc_lines.append(line.strip())
        # else: ignore any other free-form text after description block

    # Final flush
    commit()
    return result


def format_release_notes(changelog: dict[str, ReleaseEntry], include_lib_changes: bool) -> str:
    parts: list[str] = []
    for ver, entry in changelog.items():
        s = f"[bold]{ver}[/bold]"
        if entry.description:
            s += f": {entry.description}"
        if entry.entries:
            for it in entry.entries:
                if it.lower().startswith("lib:") and not include_lib_changes:
                    continue
                s += "\n[markdown.item.bullet]• [/]" + it
        parts.append(s + "\n")
    return "\n".join(parts).strip()


CHANGELOG = parse_changelog(
    (Path(__file__).parent.parent / "CHANGELOG.md").read_text(encoding="utf-8")
)

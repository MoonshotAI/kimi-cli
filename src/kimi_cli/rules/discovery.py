"""Directory discovery for Rules system.

Follows the same pattern as skills discovery for consistency.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from pathlib import Path

from kaos.path import KaosPath


def get_builtin_rules_dir() -> Path:
    """Get the built-in rules directory path (distributed with CLI)."""
    return Path(__file__).parent.parent / "rules"


def get_user_rules_dir_candidates() -> tuple[KaosPath, ...]:
    """
    Get user-level rules directory candidates in priority order.
    
    Mirrors the skill discovery priority:
    - ~/.config/agents/rules/ (recommended, consistent with skills)
    - ~/.agents/rules/
    - ~/.kimi/rules/ (backward compatibility)
    - ~/.claude/rules/
    - ~/.codex/rules/
    """
    return (
        KaosPath.home() / ".config" / "agents" / "rules",
        KaosPath.home() / ".agents" / "rules",
        KaosPath.home() / ".kimi" / "rules",
        KaosPath.home() / ".claude" / "rules",
        KaosPath.home() / ".codex" / "rules",
    )


def get_project_rules_dir_candidates(work_dir: KaosPath) -> tuple[KaosPath, ...]:
    """
    Get project-level rules directory candidates in priority order.
    
    Mirrors the skill discovery priority:
    - .agents/rules/
    - .kimi/rules/
    - .claude/rules/
    - .codex/rules/
    """
    return (
        work_dir / ".agents" / "rules",
        work_dir / ".kimi" / "rules",
        work_dir / ".claude" / "rules",
        work_dir / ".codex" / "rules",
    )


async def find_first_existing_dir(candidates: Iterable[KaosPath]) -> KaosPath | None:
    """
    Return the first existing directory from candidates.
    """
    for candidate in candidates:
        if await candidate.is_dir():
            return candidate
    return None


async def resolve_rules_roots(
    work_dir: KaosPath,
    *,
    rules_dirs: Sequence[KaosPath] | None = None,
    include_builtin: bool = True,
) -> list[KaosPath]:
    """
    Resolve layered rule roots in priority order.

    Priority (high to low):
    1. Project-level rules (.agents/rules/)
    2. User-level rules (~/.config/agents/rules/)
    3. Built-in rules (distributed with CLI)

    When ``rules_dirs`` is provided, it overrides user/project discovery.

    Args:
        work_dir: Current working directory for project-level discovery
        rules_dirs: Optional custom directories to override discovery
        include_builtin: Whether to include built-in rules

    Returns:
        List of rule directory roots in priority order
    """
    roots: list[KaosPath] = []

    if rules_dirs:
        # Custom directories override discovery
        roots.extend(rules_dirs)
    else:
        # Project-level rules have highest priority
        if project_dir := await find_first_existing_dir(get_project_rules_dir_candidates(work_dir)):
            roots.append(project_dir)

        # User-level rules
        if user_dir := await find_first_existing_dir(get_user_rules_dir_candidates()):
            roots.append(user_dir)

    # Built-in rules have lowest priority (serve as defaults)
    if include_builtin:
        builtin_dir = get_builtin_rules_dir()
        if builtin_dir.is_dir():
            roots.append(KaosPath.unsafe_from_local_path(builtin_dir))

    return roots


async def discover_rule_files(rules_dir: KaosPath) -> list[KaosPath]:
    """
    Discover all rule files in a directory.
    
    Rule files are .md files in subdirectories:
    - common/coding-style.md
    - python/testing.md
    - etc.
    
    Files directly in the root are ignored; they must be in a category directory.

    Args:
        rules_dir: Root directory containing rule categories

    Returns:
        List of paths to rule files
    """
    from kimi_cli.utils.logging import logger

    is_dir = await rules_dir.is_dir()
    logger.debug(
        "discover_rule_files: rules_dir={path} is_dir={is_dir}",
        path=rules_dir,
        is_dir=is_dir,
    )
    
    if not is_dir:
        return []

    rule_files: list[KaosPath] = []

    async for category_dir in rules_dir.iterdir():
        if not await category_dir.is_dir():
            continue

        # Skip hidden directories
        if category_dir.name.startswith("."):
            continue

        async for item in category_dir.iterdir():
            if not await item.is_file():
                continue

            # Only .md files
            if not item.name.endswith(".md"):
                continue

            # Skip hidden files and common non-rule files
            if item.name.startswith(".") or item.name.lower() in ("readme.md", "index.md"):
                continue

            rule_files.append(item)

    # Sort for deterministic ordering
    return sorted(rule_files, key=lambda p: str(p))

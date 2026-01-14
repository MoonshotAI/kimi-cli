"""Skill specification discovery and loading utilities."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from kaos import get_current_kaos
from kaos.local import local_kaos
from kaos.path import KaosPath
from loguru import logger
from pydantic import BaseModel, ConfigDict

from kimi_cli.utils.frontmatter import parse_frontmatter


def get_skills_dir() -> KaosPath:
    """
    Get the canonical user skills directory path.
    """
    return KaosPath.home() / ".config" / "agents" / "skills"


def get_builtin_skills_dir() -> Path:
    """
    Get the built-in skills directory path.
    """
    return Path(__file__).parent / "skills"


def get_kimi_skills_dir() -> KaosPath:
    """
    Get the legacy Kimi CLI skills directory path.
    """
    return KaosPath.home() / ".kimi" / "skills"


def get_claude_skills_dir() -> KaosPath:
    """
    Get the legacy Claude skills directory path.
    """
    return KaosPath.home() / ".claude" / "skills"


def get_user_skills_dir_candidates() -> tuple[KaosPath, ...]:
    """
    Get user-level skills directory candidates in priority order.
    """
    return (
        get_skills_dir(),
        get_kimi_skills_dir(),
        get_claude_skills_dir(),
    )


def get_project_skills_dir_candidates(work_dir: KaosPath) -> tuple[KaosPath, ...]:
    """
    Get project-level skills directory candidates in priority order.
    """
    return (
        work_dir / ".agents" / "skills",
        work_dir / ".kimi" / "skills",
        work_dir / ".claude" / "skills",
    )


def _supports_builtin_skills() -> bool:
    """Return True when the active KAOS backend can read bundled skills."""
    current_name = get_current_kaos().name
    return current_name in (local_kaos.name, "acp")


async def find_first_existing_dir(candidates: Iterable[KaosPath]) -> KaosPath | None:
    """
    Return the first existing directory from candidates.
    """
    for candidate in candidates:
        if await candidate.is_dir():
            return candidate
    return None


async def find_user_skills_dir() -> KaosPath | None:
    """
    Return the first existing user-level skills directory.
    """
    return await find_first_existing_dir(get_user_skills_dir_candidates())


async def find_project_skills_dir(work_dir: KaosPath) -> KaosPath | None:
    """
    Return the first existing project-level skills directory.
    """
    return await find_first_existing_dir(get_project_skills_dir_candidates(work_dir))


async def resolve_skills_roots(
    work_dir: KaosPath,
    *,
    skills_dir_override: KaosPath | None = None,
) -> list[KaosPath]:
    """
    Resolve layered skill roots in priority order.

    Built-in skills load first when supported by the active KAOS backend. When an
    override is provided, user/project discovery is skipped.
    """
    roots: list[KaosPath] = []
    if _supports_builtin_skills():
        roots.append(KaosPath.unsafe_from_local_path(get_builtin_skills_dir()))
    if skills_dir_override is not None:
        roots.append(skills_dir_override)
        return roots
    if user_dir := await find_user_skills_dir():
        roots.append(user_dir)
    if project_dir := await find_project_skills_dir(work_dir):
        roots.append(project_dir)
    return roots


def normalize_skill_name(name: str) -> str:
    """Normalize a skill name for lookup."""
    return name.casefold()


def index_skills(skills: Iterable[Skill]) -> dict[str, Skill]:
    """Build a lookup table for skills by normalized name."""
    return {normalize_skill_name(skill.name): skill for skill in skills}


async def discover_skills_from_roots(skills_dirs: Iterable[KaosPath]) -> list[Skill]:
    """
    Discover skills from multiple directory roots.
    """
    skills_by_name: dict[str, Skill] = {}
    for skills_dir in skills_dirs:
        for skill in await discover_skills(skills_dir):
            skills_by_name[normalize_skill_name(skill.name)] = skill
    return sorted(skills_by_name.values(), key=lambda s: s.name)


async def read_skill_text(skill: Skill) -> str | None:
    """Read the SKILL.md contents for a skill."""
    try:
        return (await skill.skill_md_file.read_text(encoding="utf-8")).strip()
    except OSError as exc:
        logger.warning(
            "Failed to read skill file {path}: {error}",
            path=skill.skill_md_file,
            error=exc,
        )
        return None


class Skill(BaseModel):
    """Information about a single skill."""

    model_config = ConfigDict(extra="ignore", arbitrary_types_allowed=True)

    name: str
    description: str
    dir: KaosPath

    @property
    def skill_md_file(self) -> KaosPath:
        """Path to the SKILL.md file."""
        return self.dir / "SKILL.md"


async def discover_skills(skills_dir: KaosPath) -> list[Skill]:
    """
    Discover all skills in the given directory.

    Args:
        skills_dir: Kaos path to the directory containing skills.

    Returns:
        List of Skill objects, one for each valid skill found.
    """
    if not await skills_dir.is_dir():
        return []

    skills: list[Skill] = []

    async for skill_dir in skills_dir.iterdir():
        if not await skill_dir.is_dir():
            continue

        skill_md = skill_dir / "SKILL.md"
        if not await skill_md.is_file():
            continue

        try:
            content = await skill_md.read_text(encoding="utf-8")
            skills.append(parse_skill_text(content, dir_path=skill_dir))
        except Exception as exc:
            logger.info("Skipping invalid skill at {}: {}", skill_md, exc)
            continue

    return sorted(skills, key=lambda s: s.name)


def parse_skill_text(content: str, *, dir_path: KaosPath) -> Skill:
    """
    Parse SKILL.md contents to extract name and description.
    """
    frontmatter = parse_frontmatter(content) or {}

    if "name" not in frontmatter:
        frontmatter["name"] = dir_path.name
    if "description" not in frontmatter:
        frontmatter["description"] = "No description provided."

    return Skill.model_validate(
        {
            **frontmatter,
            "dir": dir_path,
        }
    )

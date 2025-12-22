"""Skills loader for discovering and loading skills from directories."""

from __future__ import annotations

from pathlib import Path

from loguru import logger

from .models import Skill, SkillMetadata
from .parser import (
    SkillParseError,
    SkillValidationError,
    find_skill_md,
    parse_frontmatter,
    read_skill_metadata,
)


class SkillsLoader:
    """Discovers and loads skills from configured directories.

    Skills are discovered using progressive disclosure:
    1. Discovery: Load only name and description (minimal context)
    2. Activation: Load full SKILL.md when skill is needed
    """

    DEFAULT_DIRS = [
        Path.home() / ".kimi" / "skills",
        Path(".kimi") / "skills",
        Path("kimi") / "skills",
    ]

    def __init__(
        self,
        additional_dirs: list[Path] | None = None,
        disabled_skills: list[str] | None = None,
        *,
        use_default_dirs: bool = True,
    ):
        """Initialize the skills loader.

        Args:
            additional_dirs: Additional directories to scan for skills
            disabled_skills: List of skill names to skip during discovery
            use_default_dirs: Whether to include default directories (for testing)
        """
        self.skill_dirs = self.DEFAULT_DIRS.copy() if use_default_dirs else []
        if additional_dirs:
            self.skill_dirs = list(additional_dirs) + self.skill_dirs

        self._disabled_skills: set[str] = set(disabled_skills or [])
        self._metadata_cache: dict[str, SkillMetadata] = {}
        self._discovered = False

    def discover_skills(self) -> list[SkillMetadata]:
        """Scan directories for valid skills and load metadata only.

        This is called at startup to populate the skills list with
        minimal context overhead.

        Returns:
            List of SkillMetadata for all discovered skills
        """
        skills: list[SkillMetadata] = []
        seen_names: set[str] = set()

        for skill_dir in self.skill_dirs:
            # Resolve relative paths against cwd
            if not skill_dir.is_absolute():
                skill_dir = Path.cwd() / skill_dir

            if not skill_dir.exists():
                logger.debug("Skills directory does not exist: {dir}", dir=skill_dir)
                continue

            logger.info("Scanning for skills in: {dir}", dir=skill_dir)

            for entry in skill_dir.iterdir():
                if not entry.is_dir():
                    continue

                try:
                    metadata = read_skill_metadata(entry)

                    # Skip disabled skills
                    if metadata.name in self._disabled_skills:
                        logger.debug("Skipping disabled skill: {name}", name=metadata.name)
                        continue

                    # Skip duplicates (first one wins by priority)
                    if metadata.name in seen_names:
                        logger.warning(
                            "Duplicate skill '{name}' in {path}, skipping",
                            name=metadata.name,
                            path=entry,
                        )
                        continue

                    skills.append(metadata)
                    seen_names.add(metadata.name)
                    self._metadata_cache[metadata.name] = metadata
                    logger.info("Discovered skill: {name}", name=metadata.name)

                except SkillParseError as e:
                    logger.warning("Failed to parse skill in {path}: {error}", path=entry, error=e)
                except SkillValidationError as e:
                    logger.warning("Invalid skill in {path}: {error}", path=entry, error=e)
                except Exception as e:
                    logger.error(
                        "Unexpected error loading skill from {path}: {error}", path=entry, error=e
                    )

        self._discovered = True
        logger.info("Discovered {count} skills", count=len(skills))
        return skills

    def get_skill_metadata(self, name: str) -> SkillMetadata | None:
        """Get metadata for a skill by name.

        Args:
            name: The skill name

        Returns:
            SkillMetadata if found, None otherwise
        """
        if not self._discovered:
            self.discover_skills()
        return self._metadata_cache.get(name)

    def load_full_skill(self, name: str) -> Skill | None:
        """Load the full skill including instructions.

        Called when a skill is activated and full instructions are needed.

        Args:
            name: The skill name

        Returns:
            Full Skill object if found, None otherwise
        """
        metadata = self.get_skill_metadata(name)
        if metadata is None:
            return None

        skill_md = find_skill_md(metadata.path)
        if skill_md is None:
            return None

        content = skill_md.read_text(encoding="utf-8")
        _, body = parse_frontmatter(content)

        return Skill(metadata=metadata, instructions=body)

    def list_skills(self) -> list[SkillMetadata]:
        """List all discovered skills.

        Returns:
            List of all skill metadata
        """
        if not self._discovered:
            self.discover_skills()
        return list(self._metadata_cache.values())

    def refresh(self) -> list[SkillMetadata]:
        """Re-scan directories and refresh the skills cache.

        Returns:
            List of all discovered skill metadata
        """
        self._metadata_cache.clear()
        self._discovered = False
        return self.discover_skills()

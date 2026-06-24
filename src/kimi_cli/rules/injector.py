"""Rules injector for system prompt integration."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from kimi_cli.rules.discovery import resolve_rules_roots
from kimi_cli.rules.parser import parse_rule_file
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kaos.path import KaosPath

    from kimi_cli.rules.models import Rule


# Maximum total size of rules content to inject
MAX_RULES_CONTENT_SIZE = 32 * 1024  # 32KB


class RulesInjector:
    """
    Handles injection of active rules into system prompt.
    
    This is a lightweight alternative to full RulesRegistry for cases
    where we just need to load and format rules without state management.
    """

    def __init__(
        self,
        work_dir: KaosPath,
        max_size: int = MAX_RULES_CONTENT_SIZE,
    ):
        self.work_dir = work_dir
        self.max_size = max_size

    async def load_active_rules(
        self,
        file_path: Path | None = None,
    ) -> list[Rule]:
        """
        Load rules that should be active for the given context.
        
        This is a simplified version that loads all discovered rules
        without state management. For full control, use RulesRegistry.
        
        Args:
            file_path: Optional file path to filter applicable rules
        
        Returns:
            List of active rules
        """
        from kimi_cli.rules.parser import should_apply_rule

        roots = await resolve_rules_roots(self.work_dir)

        rules: list[Rule] = []
        seen_ids: set[str] = set()

        # Load from each root (project overrides user overrides builtin)
        # resolve_rules_roots returns [project, user, builtin] (high to low priority)
        # First-seen wins, so project rules take precedence over duplicates
        for root in roots:
            level = self._determine_level(root)

            from kimi_cli.rules.discovery import discover_rule_files
            rule_files = await discover_rule_files(root)

            for rule_file in rule_files:
                try:
                    rule = parse_rule_file(
                        rule_file.unsafe_to_local_path(),
                        level=level,
                        rules_root=root.unsafe_to_local_path(),
                    )

                    # Skip duplicates (higher priority wins)
                    if rule.id in seen_ids:
                        continue

                    # Check file path match if specified
                    if file_path and not should_apply_rule(rule, file_path):
                        continue

                    rules.append(rule)
                    seen_ids.add(rule.id)

                except Exception as e:
                    logger.warning(
                        "Failed to parse rule {path}: {error}",
                        path=rule_file,
                        error=e,
                    )

        # Sort by priority
        return sorted(rules, key=lambda r: r.metadata.priority)

    def _determine_level(self, root: KaosPath) -> str:
        """Determine rule level from root path."""
        from pathlib import Path

        root_str = str(root).replace("\\", "/")

        builtin_dir = str(Path(__file__).parent.parent / "rules").replace("\\", "/")
        if root_str == builtin_dir:
            return "builtin"

        work_dir_str = str(self.work_dir).replace("\\", "/")
        if root_str.startswith(work_dir_str):
            return "project"

        return "user"

    def format_rules_content(
        self,
        rules: list[Rule],
        include_source: bool = False,
    ) -> str:
        """
        Format rules for injection into system prompt.
        
        Args:
            rules: List of rules to format
            include_source: Whether to include source annotations
        
        Returns:
            Formatted rules content
        """
        if not rules:
            return ""

        parts: list[str] = []
        total_size = 0

        for rule in rules:
            content = rule.content

            # Build header
            if include_source:
                header = f"## {rule.name} ({rule.level}/{rule.id})\n\n"
            else:
                header = f"## {rule.name}\n\n"

            full_section = header + content + "\n\n"
            section_size = len(full_section.encode("utf-8"))

            # Check size limit
            if total_size + section_size > self.max_size:
                remaining = self.max_size - total_size
                if remaining > 100:  # Add truncated notice if space permits
                    parts.append(
                        "\n> _Additional rules truncated due to size limit._\n"
                    )
                break

            parts.append(full_section)
            total_size += section_size

        return "".join(parts).strip()

    async def get_injection_content(
        self,
        file_path: Path | None = None,
        include_source: bool = False,
    ) -> str:
        """
        Get formatted rules content ready for system prompt injection.
        
        Args:
            file_path: Optional file path to filter applicable rules
            include_source: Whether to include source annotations
        
        Returns:
            Formatted rules content (may be empty if no rules match)
        """
        rules = await self.load_active_rules(file_path)
        return self.format_rules_content(rules, include_source)


async def load_active_rules(
    work_dir: KaosPath,
    file_path: Path | None = None,
    max_size: int = MAX_RULES_CONTENT_SIZE,
) -> str:
    """
    Convenience function to load and format active rules.
    
    Args:
        work_dir: Current working directory
        file_path: Optional file path to filter applicable rules
        max_size: Maximum content size in bytes
    
    Returns:
        Formatted rules content for system prompt
    """
    injector = RulesInjector(work_dir, max_size=max_size)
    return await injector.get_injection_content(file_path)

"""Rule file parser with YAML frontmatter support."""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING

from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.rules.models import Rule


def parse_frontmatter(content: str) -> tuple[dict, str]:
    """
    Parse YAML frontmatter from content.
    
    Frontmatter format:
    ---
    name: "Rule Name"
    description: "Rule description"
    paths: ["**/*.py"]
    priority: 100
    ---
    
    Returns:
        Tuple of (metadata_dict, body_content)
    """
    frontmatter_pattern = r'^---\s*\n(.*?)\n---\s*\n'
    match = re.match(frontmatter_pattern, content, re.DOTALL)

    if match:
        import yaml
        try:
            metadata_yaml = match.group(1)
            body = content[match.end():]
            metadata = yaml.safe_load(metadata_yaml) or {}
            if not isinstance(metadata, dict):
                logger.warning("Invalid frontmatter format, expected dict")
                metadata = {}
            return metadata, body
        except yaml.YAMLError as e:
            logger.warning(f"Failed to parse frontmatter: {e}")
            return {}, content

    # No frontmatter found
    return {}, content


def parse_rule_file(
    path: Path,
    level: str,
    rules_root: Path | None = None,
) -> Rule:
    """
    Parse a single rule file, extracting frontmatter and content.
    
    Args:
        path: Path to the .md rule file
        level: Rule level ("builtin", "user", or "project")
        rules_root: Root directory for this level (for generating rule ID)
    
    Returns:
        Rule object
    """
    from kimi_cli.rules.models import Rule, RuleMetadata

    content = path.read_text(encoding="utf-8")
    metadata_dict, body = parse_frontmatter(content)

    # Determine category and name from path
    # Path structure: <root>/<category>/<name>.md
    if rules_root:
        rel_path = path.relative_to(rules_root)
        category = rel_path.parent.name
        name_from_path = rel_path.stem
    else:
        # Fallback: use parent directory name
        category = path.parent.name
        name_from_path = path.stem

    # Build rule ID: category/name
    rule_id = f"{category}/{name_from_path}"

    # Build metadata
    metadata = RuleMetadata(
        name=metadata_dict.get("name"),
        description=metadata_dict.get("description"),
        paths=metadata_dict.get("paths", []),
        priority=metadata_dict.get("priority", 100),
        extends=metadata_dict.get("extends", []),
    )

    # Use filename as fallback for name
    display_name = metadata.name or name_from_path.replace("-", " ").title()
    description = metadata.description or f"{display_name} guidelines"

    return Rule(
        id=rule_id,
        name=display_name,
        description=description,
        source=path,
        level=level,  # type: ignore
        category=category,
        metadata=metadata,
        content=body.strip(),
    )


def should_apply_rule(rule: Rule, file_path: Path | None) -> bool:
    """
    Check if a rule should apply to a given file path.
    
    Rules without paths metadata apply to all files.
    Rules with paths metadata only apply if the file matches one of the patterns.
    
    Args:
        rule: The rule to check
        file_path: Path to check against (None means check all rules)
    
    Returns:
        True if the rule should apply
    """
    from fnmatch import fnmatch

    # No paths specified = applies to all
    if not rule.metadata.paths:
        return True

    # No file path provided = check if rule has paths (could apply)
    if file_path is None:
        return True

    path_str = str(file_path).replace("\\", "/")

    return any(fnmatch(path_str, pattern) for pattern in rule.metadata.paths)

"""YAML frontmatter parsing for HOOK.md files."""

from pathlib import Path
from typing import Optional

import strictyaml

from .errors import ParseError, ValidationError
from .models import HookEventType, HookMatcher, HookProperties


def find_hook_md(hook_dir: Path) -> Optional[Path]:
    """Find the HOOK.md file in a hook directory.

    Prefers HOOK.md (uppercase) but accepts hook.md (lowercase).

    Args:
        hook_dir: Path to the hook directory

    Returns:
        Path to the HOOK.md file, or None if not found
    """
    for name in ("HOOK.md", "hook.md"):
        path = hook_dir / name
        if path.exists():
            return path
    return None


def parse_frontmatter(content: str) -> tuple[dict, str]:
    """Parse YAML frontmatter from HOOK.md content.

    Args:
        content: Raw content of HOOK.md file

    Returns:
        Tuple of (metadata dict, markdown body)

    Raises:
        ParseError: If frontmatter is missing or invalid
    """
    if not content.startswith("---"):
        raise ParseError("HOOK.md must start with YAML frontmatter (---)")

    parts = content.split("---", 2)
    if len(parts) < 3:
        raise ParseError("HOOK.md frontmatter not properly closed with ---")

    frontmatter_str = parts[1]
    body = parts[2].strip()

    try:
        parsed = strictyaml.load(frontmatter_str)
        metadata = parsed.data
    except strictyaml.YAMLError as e:
        raise ParseError(f"Invalid YAML in frontmatter: {e}")

    if not isinstance(metadata, dict):
        raise ParseError("HOOK.md frontmatter must be a YAML mapping")

    # Normalize metadata keys (e.g., async_ vs async)
    normalized: dict[str, object] = {}
    for k, v in metadata.items():
        # Convert async -> async_ for Python reserved words
        key = k if k != "async" else "async_"
        normalized[key] = v

    # Ensure metadata dict values are strings
    if "metadata" in normalized and isinstance(normalized["metadata"], dict):
        normalized["metadata"] = {str(k): str(v) for k, v in normalized["metadata"].items()}

    return normalized, body


def _parse_matcher(matcher_data: Optional[dict]) -> Optional[HookMatcher]:
    """Parse matcher from frontmatter data.

    Args:
        matcher_data: Raw matcher dictionary from frontmatter

    Returns:
        HookMatcher instance or None
    """
    if matcher_data is None:
        return None

    if not isinstance(matcher_data, dict):
        raise ValidationError("Field 'matcher' must be an object")

    return HookMatcher(
        tool=matcher_data.get("tool"),
        pattern=matcher_data.get("pattern"),
    )


def _parse_trigger(trigger_value: str) -> HookEventType:
    """Parse and validate trigger value.

    Args:
        trigger_value: Raw trigger string from frontmatter

    Returns:
        HookEventType enum value

    Raises:
        ValidationError: If trigger is invalid
    """
    valid_triggers = {t.value for t in HookEventType}

    if trigger_value not in valid_triggers:
        valid_list = ", ".join(sorted(valid_triggers))
        raise ValidationError(
            f"Invalid trigger '{trigger_value}'. Valid values: {valid_list}"
        )

    return HookEventType(trigger_value)


def read_properties(hook_dir: Path) -> HookProperties:
    """Read hook properties from HOOK.md frontmatter.

    This function parses the frontmatter and returns properties.
    It does NOT perform full validation. Use validate() for that.

    Args:
        hook_dir: Path to the hook directory

    Returns:
        HookProperties with parsed metadata

    Raises:
        ParseError: If HOOK.md is missing or has invalid YAML
        ValidationError: If required fields are missing or invalid
    """
    hook_dir = Path(hook_dir)
    hook_md = find_hook_md(hook_dir)

    if hook_md is None:
        raise ParseError(f"HOOK.md not found in {hook_dir}")

    content = hook_md.read_text()
    metadata, _ = parse_frontmatter(content)

    # Validate required fields
    if "name" not in metadata:
        raise ValidationError("Missing required field in frontmatter: name")
    if "description" not in metadata:
        raise ValidationError("Missing required field in frontmatter: description")
    if "trigger" not in metadata:
        raise ValidationError("Missing required field in frontmatter: trigger")

    name = metadata["name"]
    description = metadata["description"]
    trigger_value = metadata["trigger"]

    if not isinstance(name, str) or not name.strip():
        raise ValidationError("Field 'name' must be a non-empty string")
    if not isinstance(description, str) or not description.strip():
        raise ValidationError("Field 'description' must be a non-empty string")
    if not isinstance(trigger_value, str):
        raise ValidationError("Field 'trigger' must be a string")

    # Parse trigger
    trigger = _parse_trigger(trigger_value)

    # Parse matcher if present
    matcher = None
    if "matcher" in metadata:
        matcher = _parse_matcher(metadata["matcher"])

    # Parse optional fields with defaults
    timeout = 30000
    if "timeout" in metadata:
        try:
            timeout = int(metadata["timeout"])
        except (ValueError, TypeError):
            raise ValidationError("Field 'timeout' must be an integer")

    async_ = False
    if "async_" in metadata:
        async_ = bool(metadata["async_"])

    priority = 100
    if "priority" in metadata:
        try:
            priority = int(metadata["priority"])
        except (ValueError, TypeError):
            raise ValidationError("Field 'priority' must be an integer")

    # Parse metadata dict
    hook_metadata: dict[str, str] = {}
    if "metadata" in metadata and isinstance(metadata["metadata"], dict):
        hook_metadata = {str(k): str(v) for k, v in metadata["metadata"].items()}

    return HookProperties(
        name=name.strip(),
        description=description.strip(),
        trigger=trigger,
        matcher=matcher,
        timeout=timeout,
        async_=async_,
        priority=priority,
        metadata=hook_metadata,
    )

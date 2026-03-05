"""Hook validation logic."""

import re
import unicodedata
from pathlib import Path
from typing import Optional

from .errors import ParseError
from .models import HookEventType, HookValidationResult
from .parser import find_hook_md, parse_frontmatter

MAX_HOOK_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024
MAX_COMPATIBILITY_LENGTH = 500
MIN_TIMEOUT = 100
MAX_TIMEOUT = 600000
MIN_PRIORITY = 0
MAX_PRIORITY = 1000

# Allowed frontmatter fields per Agent Hooks Spec
ALLOWED_FIELDS = {
    "name",
    "description",
    "trigger",
    "matcher",
    "timeout",
    "async",
    "async_",
    "priority",
    "metadata",
}

# Valid trigger values
VALID_TRIGGERS = {t.value for t in HookEventType}


def _validate_name(name: str, hook_dir: Path) -> list[str]:
    """Validate hook name format and directory match.

    Hook names support lowercase letters, numbers, and hyphens only.
    Names must match the parent directory name.
    """
    errors = []

    if not name or not isinstance(name, str) or not name.strip():
        errors.append("Field 'name' must be a non-empty string")
        return errors

    name = unicodedata.normalize("NFKC", name.strip())

    if len(name) > MAX_HOOK_NAME_LENGTH:
        errors.append(
            f"Hook name '{name}' exceeds {MAX_HOOK_NAME_LENGTH} character limit "
            f"({len(name)} chars)"
        )

    if name != name.lower():
        errors.append(f"Hook name '{name}' must be lowercase")

    if name.startswith("-") or name.endswith("-"):
        errors.append("Hook name cannot start or end with a hyphen")

    if "--" in name:
        errors.append("Hook name cannot contain consecutive hyphens")

    # Allow letters (including Unicode), digits, and hyphens
    # This matches the skills-ref approach but restricts to lowercase
    if not all(c.isalnum() or c == "-" for c in name):
        errors.append(
            f"Hook name '{name}' contains invalid characters. "
            "Only lowercase letters, digits, and hyphens are allowed."
        )

    if hook_dir:
        dir_name = unicodedata.normalize("NFKC", hook_dir.name)
        if dir_name != name:
            errors.append(
                f"Directory name '{hook_dir.name}' must match hook name '{name}'"
            )

    return errors


def _validate_description(description: str) -> list[str]:
    """Validate description format."""
    errors = []

    if not description or not isinstance(description, str) or not description.strip():
        errors.append("Field 'description' must be a non-empty string")
        return errors

    if len(description) > MAX_DESCRIPTION_LENGTH:
        errors.append(
            f"Description exceeds {MAX_DESCRIPTION_LENGTH} character limit "
            f"({len(description)} chars)"
        )

    return errors


def _validate_trigger(trigger: str) -> list[str]:
    """Validate trigger value."""
    errors = []

    if not isinstance(trigger, str):
        errors.append("Field 'trigger' must be a string")
        return errors

    if trigger not in VALID_TRIGGERS:
        valid_list = ", ".join(sorted(VALID_TRIGGERS))
        errors.append(f"Invalid trigger '{trigger}'. Valid values: {valid_list}")

    return errors


def _validate_matcher(matcher: Optional[dict]) -> list[str]:
    """Validate matcher configuration."""
    errors = []

    if matcher is None:
        return errors

    if not isinstance(matcher, dict):
        errors.append("Field 'matcher' must be an object")
        return errors

    allowed_matcher_fields = {"tool", "pattern"}
    extra_fields = set(matcher.keys()) - allowed_matcher_fields
    if extra_fields:
        errors.append(
            f"Unexpected fields in matcher: {', '.join(sorted(extra_fields))}. "
            f"Only {sorted(allowed_matcher_fields)} are allowed."
        )

    # Validate regex patterns if present
    for field in ("tool", "pattern"):
        if field in matcher and matcher[field] is not None:
            pattern = matcher[field]
            if not isinstance(pattern, str):
                errors.append(f"Matcher field '{field}' must be a string")
            else:
                try:
                    re.compile(pattern)
                except re.error as e:
                    errors.append(f"Invalid regex in matcher.{field}: {e}")

    return errors


def _validate_timeout(timeout: object) -> list[str]:
    """Validate timeout value."""
    errors = []

    if not isinstance(timeout, int):
        errors.append("Field 'timeout' must be an integer")
        return errors

    if timeout < MIN_TIMEOUT or timeout > MAX_TIMEOUT:
        errors.append(
            f"Timeout must be between {MIN_TIMEOUT} and {MAX_TIMEOUT} ms "
            f"(got {timeout})"
        )

    return errors


def _validate_priority(priority: object) -> list[str]:
    """Validate priority value."""
    errors = []

    if not isinstance(priority, int):
        errors.append("Field 'priority' must be an integer")
        return errors

    if priority < MIN_PRIORITY or priority > MAX_PRIORITY:
        errors.append(
            f"Priority must be between {MIN_PRIORITY} and {MAX_PRIORITY} "
            f"(got {priority})"
        )

    return errors


def _validate_metadata_fields(metadata: dict) -> list[str]:
    """Validate that only allowed fields are present."""
    errors = []

    extra_fields = set(metadata.keys()) - ALLOWED_FIELDS
    if extra_fields:
        errors.append(
            f"Unexpected fields in frontmatter: {', '.join(sorted(extra_fields))}. "
            f"Only {sorted(ALLOWED_FIELDS)} are allowed."
        )

    return errors


def validate_metadata(metadata: dict, hook_dir: Optional[Path] = None) -> list[str]:
    """Validate parsed hook metadata.

    This is the core validation function that works on already-parsed metadata,
    avoiding duplicate file I/O when called from the parser.

    Args:
        metadata: Parsed YAML frontmatter dictionary
        hook_dir: Optional path to hook directory (for name-directory match check)

    Returns:
        List of validation error messages. Empty list means valid.
    """
    errors = []

    # Check for unexpected fields
    errors.extend(_validate_metadata_fields(metadata))

    # Validate required fields
    if "name" not in metadata:
        errors.append("Missing required field in frontmatter: name")
    else:
        errors.extend(_validate_name(metadata["name"], hook_dir or Path(".")))

    if "description" not in metadata:
        errors.append("Missing required field in frontmatter: description")
    else:
        errors.extend(_validate_description(metadata["description"]))

    if "trigger" not in metadata:
        errors.append("Missing required field in frontmatter: trigger")
    else:
        errors.extend(_validate_trigger(metadata["trigger"]))

    # Validate optional fields if present
    if "matcher" in metadata:
        errors.extend(_validate_matcher(metadata["matcher"]))

    if "timeout" in metadata:
        errors.extend(_validate_timeout(metadata["timeout"]))

    if "priority" in metadata:
        errors.extend(_validate_priority(metadata["priority"]))

    # async_ can be any boolean-like value, no validation needed

    return errors


def validate(hook_dir: Path) -> HookValidationResult:
    """Validate a hook directory.

    Args:
        hook_dir: Path to the hook directory

    Returns:
        HookValidationResult with valid status and any error messages
    """
    hook_dir = Path(hook_dir)

    if not hook_dir.exists():
        return HookValidationResult(valid=False, errors=[f"Path does not exist: {hook_dir}"])

    if not hook_dir.is_dir():
        return HookValidationResult(valid=False, errors=[f"Not a directory: {hook_dir}"])

    hook_md = find_hook_md(hook_dir)
    if hook_md is None:
        return HookValidationResult(valid=False, errors=["Missing required file: HOOK.md"])

    try:
        content = hook_md.read_text()
        metadata, _ = parse_frontmatter(content)
    except ParseError as e:
        return HookValidationResult(valid=False, errors=[str(e)])

    errors = validate_metadata(metadata, hook_dir)

    # Check for executable scripts if scripts/ directory exists
    scripts_dir = hook_dir / "scripts"
    if scripts_dir.exists() and scripts_dir.is_dir():
        for script_file in scripts_dir.iterdir():
            if script_file.is_file() and not script_file.stat().st_mode & 0o111:
                # Not executable
                pass  # Allow non-executable scripts, just warn

    if errors:
        return HookValidationResult(valid=False, errors=errors)

    return HookValidationResult(valid=True, errors=[])

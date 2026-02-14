"""Reference library for Agent Hooks."""

from .discovery import (
    discover_all_hooks,
    discover_hooks_in_dir,
    discover_project_hooks,
    discover_user_hooks,
    load_hooks,
    load_hooks_by_trigger,
)
from .errors import DiscoveryError, HookError, ParseError, ValidationError
from .models import (
    HookDecision,
    HookEventType,
    HookMatcher,
    HookOutput,
    HookProperties,
    HookType,
    HookValidationResult,
)
from .parser import find_hook_md, parse_frontmatter, read_properties
from .prompt import to_prompt, to_prompt_from_project
from .validator import validate, validate_metadata

__version__ = "0.1.0"

__all__ = [
    # Errors
    "HookError",
    "ParseError",
    "ValidationError",
    "DiscoveryError",
    # Models
    "HookDecision",
    "HookEventType",
    "HookType",
    "HookMatcher",
    "HookProperties",
    "HookValidationResult",
    "HookOutput",
    # Parser
    "find_hook_md",
    "parse_frontmatter",
    "read_properties",
    # Validator
    "validate",
    "validate_metadata",
    # Discovery
    "discover_user_hooks",
    "discover_project_hooks",
    "discover_hooks_in_dir",
    "discover_all_hooks",
    "load_hooks",
    "load_hooks_by_trigger",
    # Prompt
    "to_prompt",
    "to_prompt_from_project",
]

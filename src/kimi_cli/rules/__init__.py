"""Rules system for development guidelines and coding standards."""

from __future__ import annotations

from kimi_cli.rules.discovery import (
    find_first_existing_dir,
    get_builtin_rules_dir,
    get_project_rules_dir_candidates,
    get_user_rules_dir_candidates,
    resolve_rules_roots,
)
from kimi_cli.rules.injector import RulesInjector, load_active_rules
from kimi_cli.rules.models import Rule, RuleMetadata, RuleState
from kimi_cli.rules.parser import parse_rule_file
from kimi_cli.rules.registry import RulesRegistry
from kimi_cli.rules.state import RulesStateManager

__all__ = [
    "get_builtin_rules_dir",
    "get_user_rules_dir_candidates",
    "get_project_rules_dir_candidates",
    "resolve_rules_roots",
    "find_first_existing_dir",
    "Rule",
    "RuleMetadata",
    "RuleState",
    "parse_rule_file",
    "RulesRegistry",
    "RulesInjector",
    "load_active_rules",
    "RulesStateManager",
]

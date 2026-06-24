"""Rules Registry - manages rule discovery, registration, and state."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from kaos.path import KaosPath

from kimi_cli.rules.discovery import discover_rule_files, resolve_rules_roots
from kimi_cli.rules.models import Rule, RulesStats, RuleState
from kimi_cli.rules.parser import parse_rule_file, should_apply_rule
from kimi_cli.rules.state import RulesStateManager
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.config import RulesConfig


class RulesRegistry:
    """
    Registry for managing rules across all levels.
    
    Handles:
    - Discovering rules from builtin/user/project directories
    - Loading and parsing rule files
    - Managing rule enable/disable state
    - Matching rules to file paths
    """

    def __init__(
        self,
        work_dir: KaosPath,
        config: RulesConfig | None = None,
        state_manager: RulesStateManager | None = None,
    ):
        self.work_dir = work_dir
        self.config = config
        self.state_manager = state_manager or RulesStateManager(work_dir)

        self._rules: dict[str, Rule] = {}  # rule_id -> Rule
        self._state: dict[str, RuleState] = {}  # rule_id -> RuleState
        self._loaded = False

    async def load(self) -> None:
        """Load all rules from all levels."""
        if self._loaded:
            return

        # Resolve rule directories
        include_builtin = self.config.enabled if self.config else True
        roots = await resolve_rules_roots(
            self.work_dir,
            include_builtin=include_builtin,
        )

        # Load rules from each root (later roots override earlier ones for same ID)
        # resolve_rules_roots returns [project, user, builtin] (high to low priority)
        # We iterate in reverse so project rules are loaded last and override others
        for root in reversed(roots):
            await self._load_from_root(root)

        # Load persisted states
        await self._load_states()

        self._loaded = True
        logger.info(
            "Loaded {count} rules from {levels}",
            count=len(self._rules),
            levels=[r.name for r in roots],
        )

    async def _load_from_root(self, root: KaosPath) -> None:
        """Load rules from a single root directory."""
        # Determine level from root path
        level = self._determine_level(root)

        logger.debug("Loading rules from {root} (level={level})", root=root, level=level)

        rule_files = await discover_rule_files(root)
        logger.debug("Discovered {count} rule files in {root}", count=len(rule_files), root=root)

        for rule_file in rule_files:
            try:
                rule = parse_rule_file(
                    rule_file.unsafe_to_local_path(),
                    level=level,
                    rules_root=root.unsafe_to_local_path(),
                )

                # Store rule (overwrites if same ID from lower priority level)
                self._rules[rule.id] = rule

            except Exception as e:
                logger.warning(
                    "Failed to parse rule file {path}: {error}",
                    path=rule_file,
                    error=e,
                )

    def _determine_level(self, root: KaosPath) -> str:
        """Determine rule level from root path."""
        root_str = str(root).replace("\\", "/")

        # Check for builtin
        builtin_dir = str(Path(__file__).parent.parent / "rules").replace("\\", "/")
        if root_str == builtin_dir:
            return "builtin"

        # Check for project-level (within work_dir)
        work_dir_str = str(self.work_dir).replace("\\", "/")
        if root_str.startswith(work_dir_str):
            return "project"

        # Otherwise user-level
        return "user"

    async def _load_states(self) -> None:
        """Load persisted rule states."""
        if not self.state_manager:
            return

        await self.state_manager.load()

        # Apply auto-enable logic if configured
        if self.config and self.config.auto_enable_by_path:
            await self._auto_enable_rules()

        # Merge persisted states
        for rule_id, state in self.state_manager.get_all_states().items():
            if rule_id in self._rules:
                self._state[rule_id] = state

    async def _auto_enable_rules(self) -> None:
        """Auto-enable rules based on current project context."""
        # Detect project type from files
        project_types = await self._detect_project_types()

        for rule in self._rules.values():
            # Skip if already has state
            if rule.id in self._state:
                continue

            # Auto-enable based on category matching project type
            if rule.category in project_types:
                self._state[rule.id] = RuleState(enabled=True, pinned=False)
                logger.debug(
                    "Auto-enabled rule {rule_id} for {category}",
                    rule_id=rule.id,
                    category=rule.category,
                )

    async def _detect_project_types(self) -> set[str]:
        """Detect project types from file patterns."""
        types: set[str] = set()

        # Common project type detection
        detection_patterns = {
            "python": ["*.py", "pyproject.toml", "requirements.txt", "setup.py"],
            "typescript": ["*.ts", "*.tsx", "package.json", "tsconfig.json"],
            "javascript": ["*.js", "*.jsx", "package.json"],
            "go": ["*.go", "go.mod"],
            "rust": ["*.rs", "Cargo.toml"],
            "java": ["*.java", "pom.xml", "build.gradle"],
            "csharp": ["*.cs", "*.csproj", "*.sln"],
            "cpp": ["*.cpp", "*.hpp", "*.c", "*.h", "CMakeLists.txt"],
            "php": ["*.php", "composer.json"],
            "swift": ["*.swift", "Package.swift"],
            "kotlin": ["*.kt", "*.kts", "build.gradle.kts"],
        }

        for lang, patterns in detection_patterns.items():
            for pattern in patterns:
                if await self._any_file_exists(pattern):
                    types.add(lang)
                    break

        # Always include common
        types.add("common")

        return types

    async def _any_file_exists(self, pattern: str) -> bool:
        """Check if any file matching pattern exists in work_dir."""
        import fnmatch

        try:
            # KaosPath has glob() but not rglob(), use **/* for recursive
            async for item in self.work_dir.glob("**/*"):
                if fnmatch.fnmatch(item.name, pattern):
                    return True
        except Exception:
            pass
        return False

    def get_rule(self, rule_id: str) -> Rule | None:
        """Get a rule by ID."""
        return self._rules.get(rule_id)

    def get_all_rules(self) -> list[Rule]:
        """Get all rules sorted by priority."""
        return sorted(self._rules.values(), key=lambda r: r.metadata.priority)

    def get_rules_by_level(self, level: str) -> list[Rule]:
        """Get rules filtered by level."""
        return [r for r in self._rules.values() if r.level == level]

    def get_rules_by_category(self, category: str) -> list[Rule]:
        """Get rules filtered by category."""
        return [r for r in self._rules.values() if r.category == category]

    def get_active_rules(self, file_path: Path | None = None) -> list[Rule]:
        """
        Get currently enabled rules, optionally filtered by file path.
        
        Args:
            file_path: If provided, only return rules applicable to this file
        
        Returns:
            List of active rules sorted by priority
        """
        active: list[Rule] = []

        for rule_id, rule in self._rules.items():
            # Check if enabled
            state = self._state.get(rule_id, RuleState())
            if not state.enabled:
                continue

            # Check file path match
            if file_path and not should_apply_rule(rule, file_path):
                continue

            active.append(rule)

        return sorted(active, key=lambda r: r.metadata.priority)

    def is_enabled(self, rule_id: str) -> bool:
        """Check if a rule is enabled."""
        state = self._state.get(rule_id, RuleState())
        return state.enabled

    def toggle(self, rule_id: str, enabled: bool) -> bool:
        """
        Enable or disable a rule.
        
        Returns:
            True if successful, False if rule not found
        """
        if rule_id not in self._rules:
            return False

        from datetime import datetime

        rule = self._rules[rule_id]
        state = self._state.get(rule_id, RuleState())
        state.enabled = enabled
        state.pinned = True  # User action pins the state
        state.last_modified = datetime.now().isoformat()
        self._state[rule_id] = state

        # Persist state with level info for proper file separation
        if self.state_manager:
            self.state_manager.set_state(rule_id, state, level=rule.level)

        logger.info(
            "Rule {rule_id} {action}",
            rule_id=rule_id,
            action="enabled" if enabled else "disabled",
        )
        return True

    def reset_to_defaults(self, level: str | None = None) -> None:
        """
        Reset rules to default state.
        
        Args:
            level: If specified, only reset rules from this level
        """
        ids_to_reset = [
            rid for rid, r in self._rules.items()
            if level is None or r.level == level
        ]

        for rule_id in ids_to_reset:
            if rule_id in self._state:
                del self._state[rule_id]

        # Persist
        if self.state_manager:
            self.state_manager.clear_states(level)

        logger.info("Reset {count} rules to defaults", count=len(ids_to_reset))

    def get_stats(self) -> RulesStats:
        """Get statistics about loaded rules."""
        stats = RulesStats(total=len(self._rules))

        for rule_id, rule in self._rules.items():
            if self.is_enabled(rule_id):
                stats.enabled += 1

            match rule.level:
                case "builtin":
                    stats.builtin += 1
                case "user":
                    stats.user += 1
                case "project":
                    stats.project += 1

        return stats

    async def save_states(self) -> None:
        """Persist current rule states."""
        if self.state_manager:
            await self.state_manager.save()

    async def delete_state_files(self, level: str | None = None) -> None:
        """
        Delete state files from disk.
        
        Args:
            level: If specified, only delete the state file for this level
                   ("user" or "project"). If None, deletes both.
        """
        if self.state_manager:
            from typing import Literal
            level_typed: Literal["user", "project"] | None = (
                level if level in ("user", "project") else None  # type: ignore
            )
            await self.state_manager.delete_state_files(level_typed)

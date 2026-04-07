"""Rules state persistence management."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import tomlkit
from kaos.path import KaosPath
from tomlkit.exceptions import TOMLKitError

from kimi_cli.rules.models import RuleState
from kimi_cli.utils.logging import logger

STATE_FILENAME = "rules.state.toml"
USER_STATE_DIR = ".config/agents"  # ~/.config/agents/


class RulesStateManager:
    """
    Manages persistence of rule enable/disable states.
    
    States are stored at two levels:
    - User level: ~/.config/agents/rules.state.toml (global preferences)
    - Project level: .agents/rules.state.toml (project-specific overrides)
    
    Project-level states take precedence over user-level states.
    """

    def __init__(
        self,
        work_dir: KaosPath,
        user_state_path: Path | None = None,
    ):
        self.work_dir = work_dir
        # States grouped by level: {"user": {rule_id: RuleState}, "project": {...}}
        self._user_states: dict[str, RuleState] = {}
        self._project_states: dict[str, RuleState] = {}
        self._loaded = False

        # Determine state file paths
        if user_state_path:
            self.user_state_path = user_state_path
        else:
            self.user_state_path = (
                Path.home() / USER_STATE_DIR / STATE_FILENAME
            )

        # Project state path - will be determined async in load()
        self._project_state_path: Path | None = None

    async def _get_project_state_path(self) -> Path | None:
        """Async version to find project state path."""
        candidates = [
            (self.work_dir / ".agents" / STATE_FILENAME, self.work_dir / ".agents"),
            (self.work_dir / ".kimi" / STATE_FILENAME, self.work_dir / ".kimi"),
        ]

        for state_path, parent_dir in candidates:
            if await parent_dir.is_dir():
                return state_path.unsafe_to_local_path()

        # Default to .agents if neither exists (will create on save)
        return (self.work_dir / ".agents" / STATE_FILENAME).unsafe_to_local_path()

    async def load(self) -> None:
        """Load states from both user and project levels."""
        if self._loaded:
            return

        self._user_states = {}
        self._project_states = {}

        # Load user-level states first (lowest priority)
        user_states = await self._load_state_file(self.user_state_path)
        for rule_id, state in user_states.items():
            state.level = "user"
            self._user_states[rule_id] = state

        # Load project-level states (highest priority)
        project_path = await self._get_project_state_path()
        if project_path:
            project_states = await self._load_state_file(project_path)
            for rule_id, state in project_states.items():
                state.level = "project"
                self._project_states[rule_id] = state

        self._loaded = True
        total = len(self._user_states) + len(self._project_states)
        logger.debug(
            "Loaded {total} rule states ({user} user, {project} project)",
            total=total,
            user=len(self._user_states),
            project=len(self._project_states),
        )

    async def _load_state_file(self, path: Path) -> dict[str, RuleState]:
        """Load states from a single TOML file."""
        states: dict[str, RuleState] = {}

        # Convert to KaosPath for async operations if needed
        kaos_path = KaosPath(str(path))
        if not await kaos_path.is_file():
            return states

        try:
            content = await kaos_path.read_text(encoding="utf-8")
            data = tomlkit.loads(content)

            # Handle versioned format
            rules_data = data.get("rules", {})

            for rule_id, rule_data in rules_data.items():
                if isinstance(rule_data, dict):
                    states[rule_id] = RuleState.from_dict(rule_data)
                else:
                    # Simple boolean format for backward compatibility
                    states[rule_id] = RuleState(enabled=bool(rule_data))

        except (TOMLKitError, Exception) as e:
            logger.warning("Failed to load rule states from {path}: {error}", path=path, error=e)

        return states

    async def save(self) -> None:
        """Save states to appropriate level files."""
        # Save user-level states (builtin + user rules)
        if self._user_states:
            await self._save_state_file(self.user_state_path, self._user_states)
        else:
            # Empty states: delete user state file if it exists
            if self.user_state_path.exists():
                try:
                    self.user_state_path.unlink()
                    logger.debug("Deleted empty user state file: {path}", path=self.user_state_path)
                except Exception as e:
                    logger.warning("Failed to delete empty user state file: {error}", error=e)

        # Save project-level states (project rules)
        project_path = await self._get_project_state_path()
        if project_path:
            if self._project_states:
                await self._save_state_file(project_path, self._project_states)
            else:
                # Empty states: delete project state file if it exists
                if project_path.exists():
                    try:
                        project_path.unlink()
                        logger.debug("Deleted empty project state file: {path}", path=project_path)
                    except Exception as e:
                        logger.warning(
                            "Failed to delete empty project state file: {error}",
                            error=e,
                        )

    async def _save_state_file(self, path: Path, states: dict[str, RuleState]) -> None:
        """Save states to a single TOML file."""
        try:
            # Ensure directory exists
            path.parent.mkdir(parents=True, exist_ok=True)

            # Build TOML document
            doc = tomlkit.document()
            doc["version"] = "1"
            doc["updated_at"] = __import__("datetime").datetime.now().isoformat()

            rules_table = tomlkit.table()
            for rule_id, state in sorted(states.items()):
                state_dict = state.to_dict()
                if len(state_dict) == 1 and "enabled" in state_dict:
                    # Simple format for just enabled flag
                    rules_table[rule_id] = state_dict["enabled"]
                else:
                    rules_table[rule_id] = state_dict

            doc["rules"] = rules_table

            # Write atomically
            path.write_text(tomlkit.dumps(doc), encoding="utf-8")
            logger.debug("Saved {count} rule states to {path}", count=len(states), path=path)

        except Exception as e:
            logger.error("Failed to save rule states to {path}: {error}", path=path, error=e)

    def get_state(self, rule_id: str) -> RuleState | None:
        """Get state for a specific rule.
        
        Project-level states take precedence over user-level states.
        """
        # Check project-level first (higher priority)
        if rule_id in self._project_states:
            return self._project_states[rule_id]
        # Fall back to user-level
        return self._user_states.get(rule_id)

    def set_state(
        self,
        rule_id: str,
        state: RuleState,
        level: Literal["builtin", "user", "project"] | None = None,
    ) -> None:
        """Set state for a specific rule.
        
        Args:
            rule_id: The rule identifier
            state: The rule state to save
            level: The rule level determining where to save:
                - "builtin" or "user" → user-level state file
                - "project" → project-level state file
                - None → infer from existing state or default to user
        """
        # Determine target level
        if level is None:
            # Try to infer from existing state
            target_level = "project" if rule_id in self._project_states else "user"
        elif level == "builtin":
            # Builtin rules save to user-level
            target_level = "user"
        else:
            target_level = level

        # Store in appropriate bucket
        state.level = target_level  # type: ignore
        if target_level == "project":
            self._project_states[rule_id] = state
        else:
            self._user_states[rule_id] = state

    def get_all_states(self) -> dict[str, RuleState]:
        """Get all loaded states (project-level takes precedence)."""
        # Start with user states, then override with project states
        all_states = dict(self._user_states)
        all_states.update(self._project_states)
        return all_states

    def clear_states(self, level: Literal["user", "project"] | None = None) -> None:
        """
        Clear states.
        
        Args:
            level: If specified, only clear states from this level
                   ("user" or "project"). If None, clears all.
        """
        if level is None:
            self._user_states.clear()
            self._project_states.clear()
        elif level == "user":
            self._user_states.clear()
        elif level == "project":
            self._project_states.clear()

    async def migrate_from_legacy(self) -> None:
        """
        Migrate states from legacy locations if present.
        
        Legacy locations:
        - ~/.kimi/rules.state.toml
        """
        legacy_paths = [
            Path.home() / ".kimi" / STATE_FILENAME,
        ]

        for legacy_path in legacy_paths:
            if legacy_path.exists() and not self.user_state_path.exists():
                try:
                    states = await self._load_state_file(legacy_path)
                    if states:
                        for state in states.values():
                            state.level = "user"
                        self._user_states.update(states)
                        await self.save()
                        logger.info(
                            "Migrated rule states from {legacy} to {new}",
                            legacy=legacy_path,
                            new=self.user_state_path,
                        )
                        # Rename legacy file
                        legacy_path.rename(legacy_path.with_suffix(".toml.bak"))
                except Exception as e:
                    logger.warning("Failed to migrate legacy states: {error}", error=e)

    async def delete_state_files(self, level: Literal["user", "project"] | None = None) -> None:
        """
        Delete state files from disk.
        
        Args:
            level: If specified, only delete the state file for this level.
                   If None, deletes both user and project state files.
        """
        deleted = []
        
        # Delete user-level state file
        if (level is None or level == "user") and self.user_state_path.exists():
            try:
                self.user_state_path.unlink()
                deleted.append(str(self.user_state_path))
            except Exception as e:
                logger.warning("Failed to delete user state file: {error}", error=e)

        # Delete project-level state file
        if level is None or level == "project":
            project_path = await self._get_project_state_path()
            if project_path and project_path.exists():
                try:
                    project_path.unlink()
                    deleted.append(str(project_path))
                except Exception as e:
                    logger.warning("Failed to delete project state file: {error}", error=e)
        
        if deleted:
            logger.info("Deleted state files: {files}", files=deleted)

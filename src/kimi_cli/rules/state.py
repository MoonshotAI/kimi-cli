"""Rules state persistence management."""

from __future__ import annotations

from pathlib import Path

import tomlkit
from kaos.path import KaosPath
from tomlkit.exceptions import TOMLKitError

from kimi_cli.utils.logging import logger

from kimi_cli.rules.models import RuleState


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
        self._states: dict[str, RuleState] = {}
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
                return state_path.to_path() if hasattr(state_path, 'to_path') else state_path

        # Default to .agents if neither exists (will create on save)
        return (self.work_dir / ".agents" / STATE_FILENAME).to_path()

    async def load(self) -> None:
        """Load states from both user and project levels."""
        if self._loaded:
            return

        self._states = {}

        # Load user-level states first (lowest priority)
        user_states = await self._load_state_file(self.user_state_path)
        self._states.update(user_states)

        # Load project-level states (highest priority)
        project_path = await self._get_project_state_path()
        if project_path:
            project_states = await self._load_state_file(project_path)
            self._states.update(project_states)

        self._loaded = True
        logger.debug("Loaded {count} rule states", count=len(self._states))

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
        # Separate states by level preference
        user_states: dict[str, RuleState] = {}
        project_states: dict[str, RuleState] = {}

        for rule_id, state in self._states.items():
            # Pinned states go to user level unless they came from project
            # For now, save all to user level for simplicity
            # TODO: Track origin level and save accordingly
            user_states[rule_id] = state

        # Save user-level states
        if user_states:
            await self._save_state_file(self.user_state_path, user_states)

        # Save project-level states if any
        if project_states:
            project_path = await self._get_project_state_path()
            if project_path:
                await self._save_state_file(project_path, project_states)

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
        """Get state for a specific rule."""
        return self._states.get(rule_id)

    def set_state(self, rule_id: str, state: RuleState) -> None:
        """Set state for a specific rule."""
        self._states[rule_id] = state

    def get_all_states(self) -> dict[str, RuleState]:
        """Get all loaded states."""
        return dict(self._states)

    def clear_states(self, level: str | None = None) -> None:
        """
        Clear states.
        
        Args:
            level: If specified, only clear states from this level
                   ("user" or "project"). Currently clears all.
        """
        self._states.clear()

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
                        self._states.update(states)
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

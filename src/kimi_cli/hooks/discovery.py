"""Hook discovery mechanism for AgentHooks standard."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from kimi_cli.hooks.parser import ParsedHook, HookParser
from kimi_cli.utils.logging import logger


def _to_path(path: Path | object) -> Path:
    """Convert a path-like object (including KaosPath) to a standard Path.

    Args:
        path: A Path or any path-like object with a string representation.

    Returns:
        A standard pathlib.Path object.
    """
    if isinstance(path, Path):
        return path
    # Handle KaosPath and other path-like objects by converting via string
    return Path(str(path))


@dataclass(frozen=True, slots=True)
class DiscoveryPaths:
    """Paths where hooks are discovered."""

    user_hooks: Path  # ~/.config/agents/hooks/
    project_hooks: Path | None  # ./.agents/hooks/

    @classmethod
    def from_work_dir(cls, work_dir: Path) -> DiscoveryPaths:
        """Create discovery paths from working directory."""
        # Convert work_dir to standard Path (handles KaosPath)
        work_dir = _to_path(work_dir)

        # User-level hooks (XDG)
        xdg_config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
        user_hooks = xdg_config_home / "agents" / "hooks"

        # Project-level hooks
        project_hooks = work_dir / ".agents" / "hooks"
        if not project_hooks.exists():
            project_hooks = None

        return cls(user_hooks=user_hooks, project_hooks=project_hooks)


class HookDiscovery:
    """Discover hooks from filesystem following AgentHooks standard."""

    def __init__(self, work_dir: Path | object | None = None):
        """Initialize hook discovery.

        Args:
            work_dir: Working directory for project-level hook discovery.
                     Can be a Path or KaosPath. If None, uses current working directory.
        """
        if work_dir is None:
            work_dir = Path.cwd()
        else:
            # Convert to standard Path (handles KaosPath)
            work_dir = _to_path(work_dir)
        self.paths = DiscoveryPaths.from_work_dir(work_dir)
        self._cache: list[ParsedHook] | None = None

    def discover(self, use_cache: bool = True) -> list[ParsedHook]:
        """Discover all hooks from configured paths.

        Discovery order (later overrides earlier):
        1. User-level hooks (~/.config/agents/hooks/)
        2. Project-level hooks (./.agents/hooks/)

        Args:
            use_cache: Whether to use cached results

        Returns:
            List of parsed hooks sorted by priority (highest first)
        """
        if use_cache and self._cache is not None:
            return self._cache

        hooks: dict[str, ParsedHook] = {}

        # Discover user-level hooks first
        if self.paths.user_hooks.exists():
            logger.debug("Discovering user-level hooks from {path}", path=self.paths.user_hooks)
            for hook in self._scan_directory(self.paths.user_hooks):
                hooks[hook.name] = hook

        # Project-level hooks override user-level
        if self.paths.project_hooks and self.paths.project_hooks.exists():
            logger.debug(
                "Discovering project-level hooks from {path}", path=self.paths.project_hooks
            )
            for hook in self._scan_directory(self.paths.project_hooks):
                if hook.name in hooks:
                    logger.warning(
                        "Project hook '{name}' overrides user-level hook", name=hook.name
                    )
                hooks[hook.name] = hook

        # Sort by priority (highest first), then by name for stable ordering
        sorted_hooks = sorted(hooks.values(), key=lambda h: (-h.metadata.priority, h.name))

        self._cache = sorted_hooks
        logger.info("Discovered {count} hook(s)", count=len(sorted_hooks))
        return sorted_hooks

    def discover_by_trigger(self, trigger: str) -> list[ParsedHook]:
        """Discover hooks filtered by trigger type.

        Args:
            trigger: Event type (e.g., 'pre-tool-call', 'pre-session')

        Returns:
            List of parsed hooks for the given trigger
        """
        all_hooks = self.discover()
        return [h for h in all_hooks if h.metadata.trigger == trigger]

    def invalidate_cache(self) -> None:
        """Invalidate the discovery cache."""
        self._cache = None
        logger.debug("Hook discovery cache invalidated")

    def _scan_directory(self, hooks_dir: Path) -> Iterator[ParsedHook]:
        """Scan a directory for hook subdirectories.

        Args:
            hooks_dir: Directory containing hook subdirectories

        Yields:
            ParsedHook objects
        """
        if not hooks_dir.is_dir():
            return

        for entry in hooks_dir.iterdir():
            if not entry.is_dir():
                continue

            hook_md = entry / "HOOK.md"
            if not hook_md.exists():
                continue

            try:
                hook = HookParser.parse(entry)
                logger.debug("Parsed hook: {name} ({trigger})", name=hook.name, trigger=hook.trigger)
                yield hook
            except FileNotFoundError:
                logger.warning("HOOK.md not found in {path}", path=entry)
            except ValueError as e:
                logger.warning("Invalid HOOK.md in {path}: {error}", path=entry, error=e)
            except Exception as e:
                logger.exception("Failed to parse hook in {path}", path=entry, error=e)

    def get_hook_by_name(self, name: str) -> ParsedHook | None:
        """Get a specific hook by name.

        Args:
            name: Hook name

        Returns:
            ParsedHook or None if not found
        """
        for hook in self.discover():
            if hook.name == name:
                return hook
        return None

    def list_all_triggers(self) -> set[str]:
        """Get all unique trigger types discovered.

        Returns:
            Set of trigger type strings
        """
        return {h.metadata.trigger for h in self.discover()}

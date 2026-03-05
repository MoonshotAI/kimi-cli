from __future__ import annotations

from enum import Enum, auto


class PlanMode(Enum):
    """ACT = normal execution, PLAN = planning mode."""

    ACT = auto()
    PLAN = auto()


class ModeManager:
    """Manage ACT/PLAN mode switching with singleton pattern."""

    _instance = None
    _mode: PlanMode = PlanMode.ACT
    _listeners: list[callable] = []
    _suppress_spinner: bool = False  # Suppress spinner during planning

    @classmethod
    def get_instance(cls) -> "ModeManager":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def toggle(self) -> PlanMode:
        """Toggle between ACT and PLAN modes."""
        self._mode = PlanMode.ACT if self._mode == PlanMode.PLAN else PlanMode.PLAN
        self._notify_listeners()
        return self._mode

    def get(self) -> PlanMode:
        return self._mode

    def is_plan_mode(self) -> bool:
        return self._mode == PlanMode.PLAN

    def set(self, mode: PlanMode):
        """Set mode directly."""
        self._mode = mode
        self._notify_listeners()

    def add_listener(self, callback: callable):
        """Add callback to be called when mode changes."""
        self._listeners.append(callback)

    def _notify_listeners(self):
        for listener in self._listeners:
            listener(self._mode)

    @property
    def mode_prefix(self) -> str:
        """Return status bar prefix: [ACT] or [PLAN]."""
        return "[PLAN]" if self.is_plan_mode() else "[ACT]"

    @property
    def suppress_spinner(self) -> bool:
        """Return whether to suppress spinner output."""
        return self._suppress_spinner

    def set_suppress_spinner(self, value: bool):
        """Set whether to suppress spinner output."""
        self._suppress_spinner = value


# Global accessor
def get_mode_manager() -> ModeManager:
    return ModeManager.get_instance()

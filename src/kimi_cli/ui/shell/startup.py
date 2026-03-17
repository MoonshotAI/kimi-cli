from __future__ import annotations

from rich.status import Status

from kimi_cli.ui.shell.console import console


class ShellStartupProgress:
    """Transient startup status shown while the shell is initializing."""

    def __init__(self, *, enabled: bool | None = None) -> None:
        self._enabled = console.is_terminal if enabled is None else enabled
        self._status: Status | None = None

    def update(self, message: str) -> None:
        if not self._enabled:
            return

        status_message = f"[cyan]{message}[/cyan]"
        if self._status is None:
            self._status = console.status(status_message, spinner="dots")
            self._status.start()
            return

        self._status.update(status_message)

    def stop(self) -> None:
        if self._status is None:
            return

        self._status.stop()
        self._status = None

"""Multi-session IPC hub for high-throughput streaming.

Manages multiple IpcWireServer instances, one per session, with a unified
socket directory. Designed for Kimi Studio to connect to multiple concurrent
CLI sessions over Unix domain sockets.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from kimi_cli.utils.logging import logger


class IpcHub:
    """Central registry for IPC socket paths across sessions.

    Writes a JSON index file that external consumers (like Kimi Studio)
    can watch to discover active sessions.
    """

    def __init__(self, socket_dir: str | None = None) -> None:
        self.socket_dir = socket_dir or self._default_socket_dir()
        self._sessions: dict[str, str] = {}  # session_id -> socket_path
        self._index_path = os.path.join(self.socket_dir, "index.json")
        Path(self.socket_dir).mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _default_socket_dir() -> str:
        """Default socket directory: ~/.kimi/sockets/"""
        return os.path.join(os.path.expanduser("~"), ".kimi", "sockets")

    def register(self, session_id: str, socket_path: str) -> None:
        """Register a session's socket path."""
        self._sessions[session_id] = socket_path
        self._write_index()
        logger.info("IPC hub registered session %s at %s", session_id, socket_path)

    def unregister(self, session_id: str) -> None:
        """Remove a session from the registry."""
        self._sessions.pop(session_id, None)
        self._write_index()
        logger.info("IPC hub unregistered session %s", session_id)

    def _write_index(self) -> None:
        """Write the session index file."""
        try:
            with open(self._index_path, "w") as f:
                json.dump(
                    {
                        "version": 1,
                        "socket_dir": self.socket_dir,
                        "sessions": self._sessions,
                    },
                    f,
                    indent=2,
                )
        except OSError as e:
            logger.warning("Failed to write IPC index: %s", e)

    def get_socket_path(self, session_id: str) -> str | None:
        """Get the socket path for a session."""
        return self._sessions.get(session_id)

    def list_sessions(self) -> dict[str, str]:
        """List all registered sessions."""
        return dict(self._sessions)

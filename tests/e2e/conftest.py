"""Configuration for e2e tests that rely on Unix PTY infrastructure."""

from __future__ import annotations

import sys

# PTY-based e2e tests depend on Unix-only modules (fcntl, termios, pty).
# Skip the entire directory on Windows to prevent ImportError during collection.
collect_ignore_glob = ["test_*.py"] if sys.platform == "win32" else []

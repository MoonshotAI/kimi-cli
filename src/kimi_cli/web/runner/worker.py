"""Worker module for running KimiCLI in a subprocess.

This module is the entry point for the subprocess that runs KimiCLI in wire mode.
It reads the session configuration from disk and runs KimiCLI.run_wire_stdio().

Usage:
    python -m kimi_cli.web.runner.worker <session_id>
"""

from __future__ import annotations

import asyncio
import sys
from uuid import UUID

from kimi_cli.app import KimiCLI, enable_logging
from kimi_cli.web.store.sessions import load_session_by_id


async def run_worker(session_id: UUID) -> None:
    """Run the KimiCLI worker for a session."""
    # Find session by ID using the web store
    joint_session = load_session_by_id(session_id)
    if joint_session is None:
        raise ValueError(f"Session not found: {session_id}")

    # Get the kimi-cli session object
    session = joint_session.kimi_cli_session

    # Create KimiCLI instance using default configuration
    kimi_cli = await KimiCLI.create(session)

    # Run in wire stdio mode
    await kimi_cli.run_wire_stdio()


def main() -> None:
    """Entry point for the worker subprocess."""
    if len(sys.argv) < 2:
        print("Usage: python -m kimi_cli.web.runner.worker <session_id>", file=sys.stderr)
        sys.exit(1)

    try:
        session_id = UUID(sys.argv[1])
    except ValueError:
        print(f"Invalid session ID: {sys.argv[1]}", file=sys.stderr)
        sys.exit(1)

    # Enable logging for the subprocess
    enable_logging(debug=False)

    # Run the async worker
    asyncio.run(run_worker(session_id))


if __name__ == "__main__":
    main()

"""Adapter for ACP terminal operations.

The ``acp.TerminalHandle`` convenience class was removed in
agent-client-protocol >= 0.8.0.  This module provides a lightweight
replacement that wraps the raw ``acp.Client`` terminal methods behind
the same interface that ``tools.py`` and ``kaos.py`` expect.
"""

from __future__ import annotations

from dataclasses import dataclass

import acp
import acp.schema


@dataclass(slots=True)
class TerminalHandle:
    """Thin wrapper exposing terminal operations on an ``acp.Client``."""

    id: str
    _client: acp.Client
    _session_id: str

    async def wait_for_exit(self) -> acp.schema.WaitForTerminalExitResponse:
        return await self._client.wait_for_terminal_exit(
            session_id=self._session_id, terminal_id=self.id
        )

    async def current_output(self) -> acp.schema.TerminalOutputResponse:
        return await self._client.terminal_output(
            session_id=self._session_id, terminal_id=self.id
        )

    async def kill(self) -> None:
        await self._client.kill_terminal(
            session_id=self._session_id, terminal_id=self.id
        )

    async def release(self) -> None:
        await self._client.release_terminal(
            session_id=self._session_id, terminal_id=self.id
        )


async def create_terminal(
    client: acp.Client,
    *,
    command: str,
    session_id: str,
    output_byte_limit: int | None = None,
) -> TerminalHandle:
    """Create a terminal and return a :class:`TerminalHandle`."""
    resp = await client.create_terminal(
        command=command,
        session_id=session_id,
        output_byte_limit=output_byte_limit,
    )
    return TerminalHandle(id=resp.terminal_id, _client=client, _session_id=session_id)

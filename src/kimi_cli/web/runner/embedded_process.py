"""Embedded session process for the Kimi CLI web interface."""

from __future__ import annotations

import json
import time
from typing import Any
from uuid import UUID, uuid4

from kimi_cli import logger
from kimi_cli.app import KimiCLI
from kimi_cli.cli.mcp import get_global_mcp_config_file
from kimi_cli.exception import MCPConfigError
from kimi_cli.web.runner.embedded_worker import EmbeddedWireWorker
from kimi_cli.web.runner.process import SessionProcess
from kimi_cli.web.store.sessions import load_session_by_id
from kimi_cli.wire.jsonrpc import (
    JSONRPCCancelMessage,
    JSONRPCInMessageAdapter,
    JSONRPCPromptMessage,
    JSONRPCSuccessResponse,
)


async def _create_kimi_cli_for_session(session_id: UUID) -> KimiCLI:
    joint_session = load_session_by_id(session_id)
    if joint_session is None:
        raise ValueError(f"Session not found: {session_id}")

    session = joint_session.kimi_cli_session

    default_mcp_file = get_global_mcp_config_file()
    mcp_configs: list[dict[str, Any]] = []
    if default_mcp_file.exists():
        raw = default_mcp_file.read_text(encoding="utf-8")
        try:
            mcp_configs = [json.loads(raw)]
        except json.JSONDecodeError:
            logger.warning(
                "Invalid JSON in MCP config file: {path}",
                path=default_mcp_file,
            )

    try:
        return await KimiCLI.create(session, mcp_configs=mcp_configs or None)
    except MCPConfigError as exc:
        logger.warning(
            "Invalid MCP config in {path}: {error}. Starting without MCP.",
            path=default_mcp_file,
            error=exc,
        )
        return await KimiCLI.create(session, mcp_configs=None)


class EmbeddedSessionProcess(SessionProcess):
    """Manage one session using an in-process wire worker."""

    def __init__(self, session_id: UUID) -> None:
        super().__init__(session_id)
        self._worker: EmbeddedWireWorker | None = None

    @property
    def is_alive(self) -> bool:
        return self._worker is not None

    async def start(
        self,
        *,
        reason: str | None = None,
        detail: str | None = None,
        restart_started_at: float | None = None,
    ) -> None:
        """Start the embedded worker."""
        async with self._lock:
            if self.is_alive:
                return

            self._in_flight_prompt_ids.clear()
            self._worker_id = str(uuid4())

            try:
                kimi_cli = await _create_kimi_cli_for_session(self.session_id)
                worker = EmbeddedWireWorker(
                    kimi_cli,
                    emit_json=self._process_worker_output_line,
                )
                await worker.start()
            except Exception:
                self._worker_id = None
                raise

            self._worker = worker

            if restart_started_at is not None:
                elapsed_ms = int((time.perf_counter() - restart_started_at) * 1000)
                detail = f"restart_ms={elapsed_ms}"
                await self._emit_status("idle", reason=reason or "start", detail=detail)
                await self._emit_restart_notice(reason=reason, restart_ms=elapsed_ms)
            else:
                await self._emit_status("idle", reason=reason or "start", detail=None)

    async def stop_worker(
        self,
        *,
        reason: str | None = None,
        emit_status: bool = True,
    ) -> None:
        """Stop only the embedded worker, keeping WebSockets connected."""
        async with self._lock:
            worker = self._worker
            self._worker = None

            if worker is not None:
                await worker.stop()

            self._in_flight_prompt_ids.clear()
            self._worker_id = None
            if emit_status:
                await self._emit_status("stopped", reason=reason or "stop")

    async def send_message(self, message: str) -> None:
        """Send a message to the embedded worker."""
        await self.start()
        worker = self._worker
        assert worker is not None

        try:
            in_message = JSONRPCInMessageAdapter.validate_json(message)
            if isinstance(in_message, JSONRPCPromptMessage):
                was_busy = self.is_busy
                self._in_flight_prompt_ids.add(in_message.id)
                if not was_busy:
                    await self._emit_status("busy", reason="prompt")
            elif isinstance(in_message, JSONRPCCancelMessage) and not self.is_busy:
                await self._broadcast(
                    JSONRPCSuccessResponse(id=in_message.id, result={}).model_dump_json()
                )
                return

            new_message = await self._handle_in_message(in_message)
            if new_message is not None:
                message = new_message
        except ValueError as e:
            logger.error(f"{e.__class__.__name__} {e}: Invalid JSONRPC in message: {message}")
            return

        await worker.handle_message(message)

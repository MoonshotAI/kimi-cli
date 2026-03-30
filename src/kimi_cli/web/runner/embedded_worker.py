"""In-process wire worker for the Kimi CLI web interface."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

import pydantic

from kimi_cli.app import KimiCLI
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.jsonrpc import (
    ErrorCodes,
    JSONRPCErrorObject,
    JSONRPCErrorResponse,
    JSONRPCErrorResponseNullableID,
    JSONRPCInMessageAdapter,
    JSONRPCMessage,
    JSONRPCOutMessage,
)
from kimi_cli.wire.server import WireServer

_PROMPT_ENV_LOCK = asyncio.Lock()


class EmbeddedWireWorker(WireServer):
    """Run the wire protocol against a local ``KimiCLI`` instance."""

    def __init__(
        self,
        kimi_cli: KimiCLI,
        *,
        emit_json: Callable[[str], Awaitable[None]],
    ) -> None:
        super().__init__(kimi_cli.soul)
        self._kimi_cli = kimi_cli
        self._emit_json = emit_json
        self._emit_lock = asyncio.Lock()

    async def start(self) -> None:
        """Start the in-process worker."""
        if isinstance(self._soul, KimiSoul) and self._root_hub_task is None:
            runtime = self._kimi_cli.soul.runtime
            if runtime.root_wire_hub is not None:
                self._root_hub_queue = runtime.root_wire_hub.subscribe()
                self._root_hub_task = asyncio.create_task(self._root_hub_loop())

    async def stop(self) -> None:
        """Stop the in-process worker."""
        await self._shutdown()

    async def handle_message(self, message: str) -> None:
        """Handle a JSON-RPC message from the web client."""
        try:
            msg_json = json.loads(message)
        except ValueError:
            await self._emit_out_message(
                JSONRPCErrorResponseNullableID(
                    id=None,
                    error=JSONRPCErrorObject(
                        code=ErrorCodes.PARSE_ERROR,
                        message="Invalid JSON format",
                    ),
                )
            )
            return

        try:
            generic_msg = JSONRPCMessage.model_validate(msg_json)
        except pydantic.ValidationError:
            await self._emit_out_message(
                JSONRPCErrorResponseNullableID(
                    id=None,
                    error=JSONRPCErrorObject(
                        code=ErrorCodes.INVALID_REQUEST,
                        message="Invalid request",
                    ),
                )
            )
            return

        if generic_msg.is_response():
            try:
                msg = JSONRPCInMessageAdapter.validate_python(msg_json)
            except pydantic.ValidationError:
                await self._emit_out_message(
                    JSONRPCErrorResponseNullableID(
                        id=None,
                        error=JSONRPCErrorObject(
                            code=ErrorCodes.INVALID_REQUEST,
                            message="Invalid response",
                        ),
                    )
                )
                return
            self._dispatch(msg)
            return

        if not generic_msg.method_is_inbound():
            if generic_msg.id is not None:
                await self._emit_out_message(
                    JSONRPCErrorResponse(
                        id=generic_msg.id,
                        error=JSONRPCErrorObject(
                            code=ErrorCodes.METHOD_NOT_FOUND,
                            message=f"Unexpected method received: {generic_msg.method}",
                        ),
                    )
                )
            return

        try:
            msg = JSONRPCInMessageAdapter.validate_python(msg_json)
        except pydantic.ValidationError:
            if generic_msg.id is not None:
                await self._emit_out_message(
                    JSONRPCErrorResponse(
                        id=generic_msg.id,
                        error=JSONRPCErrorObject(
                            code=ErrorCodes.INVALID_PARAMS,
                            message=f"Invalid parameters for method `{generic_msg.method}`",
                        ),
                    )
                )
            return

        self._dispatch(msg)

    def _dispatch(self, msg: Any) -> None:
        task = asyncio.create_task(self._dispatch_msg(msg))
        task.add_done_callback(self._dispatch_tasks.discard)
        self._dispatch_tasks.add(task)

    async def _send_msg(self, msg: JSONRPCOutMessage) -> None:
        await self._emit_out_message(msg)

    async def _emit_out_message(self, msg: Any) -> None:
        payload = msg.model_dump_json()
        async with self._emit_lock:
            await self._emit_json(payload)

    async def _handle_prompt(self, msg):  # type: ignore[override]
        # ``KimiCLI.run_wire_stdio()`` normally keeps the entire wire server inside
        # the session environment context. For the embedded worker we scope that environment to
        # each foreground turn and serialize embedded prompts to avoid cross-session
        # cwd races from ``kaos.chdir()``.
        async with _PROMPT_ENV_LOCK, self._kimi_cli.env():
            return await super()._handle_prompt(msg)

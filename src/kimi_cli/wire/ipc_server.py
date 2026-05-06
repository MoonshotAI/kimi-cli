"""High-throughput IPC server for Kimi Studio and external consumers.

Uses Unix domain sockets for local streaming with support for:
- Multiple concurrent sessions (one socket per session)
- Line-delimited JSON-RPC (same protocol as stdio wire)
- Zero-copy via asyncio (no subprocess overhead)
- Auto-cleanup of socket files on exit
"""

from __future__ import annotations

import asyncio
import atexit
import contextlib
import json
import os
import tempfile
from pathlib import Path

import pydantic

from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.utils.logging import logger
from kimi_cli.wire.jsonrpc import (
    ErrorCodes,
    JSONRPCErrorObject,
    JSONRPCErrorResponse,
    JSONRPCErrorResponseNullableID,
    JSONRPCInMessageAdapter,
    JSONRPCMessage,
    JSONRPCOutMessage,
    JSONRPCSuccessResponse,
)
from kimi_cli.wire.server import WireServer


class IpcWireServer(WireServer):
    """Wire server that listens on a Unix domain socket instead of stdio.

    Each session gets its own socket path (e.g. /tmp/kimi-{session_id}.sock).
    Multiple clients can connect to the same socket for broadcast consumption.
    """

    def __init__(self, soul: KimiSoul, socket_path: str | None = None) -> None:
        super().__init__(soul)
        self.socket_path = socket_path or self._make_socket_path()
        self._server: asyncio.Server | None = None
        self._clients: set[asyncio.StreamWriter] = set()
        self._client_lock = asyncio.Lock()
        self._cleanup_registered = False

    @staticmethod
    def _make_socket_path() -> str:
        """Generate a unique socket path in the system temp directory."""
        explicit_path = os.getenv("KIMI_WIRE_IPC_SOCKET_PATH")
        if explicit_path:
            Path(explicit_path).parent.mkdir(parents=True, exist_ok=True)
            return explicit_path
        socket_dir = os.getenv("KIMI_WIRE_IPC_SOCKET_DIR")
        if socket_dir:
            Path(socket_dir).mkdir(parents=True, exist_ok=True)
            return os.path.join(socket_dir, f"kimi-{os.getpid()}-{id(object()):x}.sock")
        tmpdir = tempfile.gettempdir()
        # Include PID for uniqueness across processes
        return os.path.join(tmpdir, f"kimi-{os.getpid()}-{id(object()):x}.sock")

    def _register_cleanup(self) -> None:
        """Register socket file cleanup on process exit."""
        if self._cleanup_registered:
            return
        self._cleanup_registered = True
        path = self.socket_path
        atexit.register(lambda: _remove_socket(path))

    async def serve(self) -> None:
        """Start the IPC server and accept connections."""
        self._register_cleanup()
        # Remove stale socket if it exists
        _remove_socket(self.socket_path)

        self._server = await asyncio.start_unix_server(
            self._handle_client_async,
            path=self.socket_path,
            limit=2**16,
        )
        logger.info("IPC server listening on %s", self.socket_path)

        # Start the broadcast write loop (consumes self._write_queue)
        self._write_task = asyncio.create_task(self._write_loop())

        # Write socket path to stdout so parent process knows where to connect
        print(json.dumps({"socket_path": self.socket_path, "status": "ready"}), flush=True)

        # Run the root hub loop for approval forwarding (same as stdio)
        if isinstance(self._soul, KimiSoul) and self._soul.runtime.root_wire_hub is not None:
            self._root_hub_queue = self._soul.runtime.root_wire_hub.subscribe()
            self._root_hub_task = asyncio.create_task(self._root_hub_loop())

        # Keep serving until cancelled
        try:
            await self._server.serve_forever()
        except asyncio.CancelledError:
            logger.info("IPC server cancelled, shutting down")
            raise
        finally:
            await self._shutdown()

    async def _handle_client_async(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        """Async handler for a new client connection."""
        peer = writer.get_extra_info("peername")
        logger.info("IPC client connected: %s", peer)
        async with self._client_lock:
            self._clients.add(writer)

        try:
            # Read loop - parse JSON-RPC from client
            while True:
                raw_line = await reader.readline()
                if not raw_line:
                    logger.info("IPC client disconnected: %s", peer)
                    break
                await self._dispatch_client_message(raw_line, writer)

        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("IPC client handler error")
        finally:
            async with self._client_lock:
                self._clients.discard(writer)
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _dispatch_client_message(
        self,
        raw_line: bytes,
        writer: asyncio.StreamWriter,
    ) -> None:
        """Dispatch an incoming message from a client."""
        try:
            line = raw_line.decode("utf-8", errors="replace").strip()
        except UnicodeDecodeError:
            logger.warning("IPC client sent invalid UTF-8: %s", raw_line[:200])
            return

        if not line:
            return

        try:
            msg_json = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("IPC client sent invalid JSON: %s", raw_line[:200])
            await self._send_direct(
                writer,
                JSONRPCErrorResponseNullableID(
                    id=None,
                    error=JSONRPCErrorObject(
                        code=ErrorCodes.PARSE_ERROR,
                        message="Invalid JSON format",
                    ),
                ),
            )
            return

        try:
            generic_msg = JSONRPCMessage.model_validate(msg_json)
        except pydantic.ValidationError as e:
            logger.error("Invalid JSON-RPC message from IPC client: {error}", error=e)
            await self._send_direct(
                writer,
                JSONRPCErrorResponseNullableID(
                    id=None,
                    error=JSONRPCErrorObject(
                        code=ErrorCodes.INVALID_REQUEST,
                        message="Invalid request",
                    ),
                ),
            )
            return

        if generic_msg.is_response():
            try:
                msg = JSONRPCInMessageAdapter.validate_python(msg_json)
            except pydantic.ValidationError as e:
                logger.error("Invalid JSON-RPC response from IPC client: {error}", error=e)
                await self._send_direct(
                    writer,
                    JSONRPCErrorResponseNullableID(
                        id=None,
                        error=JSONRPCErrorObject(
                            code=ErrorCodes.INVALID_REQUEST,
                            message="Invalid response",
                        ),
                    ),
                )
                return

            if not isinstance(msg, (JSONRPCSuccessResponse, JSONRPCErrorResponse)):
                logger.error(
                    "Invalid JSON-RPC response message from IPC client: {msg}",
                    msg=msg_json,
                )
                return

            task = asyncio.create_task(self._dispatch_msg(msg))
            task.add_done_callback(self._dispatch_tasks.discard)
            self._dispatch_tasks.add(task)
            return

        if not generic_msg.method_is_inbound():
            logger.error(
                "Unexpected JSON-RPC method received from IPC client: {method}",
                method=generic_msg.method,
            )
            if generic_msg.id is not None:
                await self._send_direct(
                    writer,
                    JSONRPCErrorResponse(
                        id=generic_msg.id,
                        error=JSONRPCErrorObject(
                            code=ErrorCodes.METHOD_NOT_FOUND,
                            message=f"Unexpected method received: {generic_msg.method}",
                        ),
                    ),
                )
            return

        try:
            msg = JSONRPCInMessageAdapter.validate_python(msg_json)
        except pydantic.ValidationError as e:
            logger.error("Invalid JSON-RPC inbound message from IPC client: {error}", error=e)
            if generic_msg.id is not None:
                await self._send_direct(
                    writer,
                    JSONRPCErrorResponse(
                        id=generic_msg.id,
                        error=JSONRPCErrorObject(
                            code=ErrorCodes.INVALID_PARAMS,
                            message=f"Invalid parameters for method `{generic_msg.method}`",
                        ),
                    ),
                )
            return

        task = asyncio.create_task(self._dispatch_msg(msg))
        task.add_done_callback(self._dispatch_tasks.discard)
        self._dispatch_tasks.add(task)

    @staticmethod
    async def _send_direct(
        writer: asyncio.StreamWriter,
        msg: JSONRPCOutMessage,
    ) -> None:
        """Send a protocol-level error directly to the client that caused it."""
        writer.write(msg.model_dump_json().encode("utf-8") + b"\n")
        await writer.drain()

    async def _broadcast(self, msg: JSONRPCOutMessage) -> None:
        """Broadcast a message to all connected clients."""
        async with self._client_lock:
            dead_clients: set[asyncio.StreamWriter] = set()
            for writer in self._clients:
                try:
                    data = msg.model_dump_json().encode("utf-8") + b"\n"
                    writer.write(data)
                except Exception:
                    dead_clients.add(writer)
            # Drain all at once
            for writer in self._clients:
                if writer not in dead_clients:
                    try:
                        await writer.drain()
                    except Exception:
                        dead_clients.add(writer)
            self._clients -= dead_clients

    async def _write_loop(self) -> None:
        """Override: broadcast to all IPC clients instead of writing to stdout."""
        try:
            while True:
                try:
                    msg = await self._write_queue.get()
                except Exception:
                    logger.debug("IPC send queue shut down")
                    break
                await self._broadcast(msg)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("IPC broadcast loop error")
            raise

    async def _shutdown(self) -> None:
        """Clean up server and socket."""
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        async with self._client_lock:
            writers = list(self._clients)
            self._clients.clear()
        for writer in writers:
            writer.close()
        for writer in writers:
            with contextlib.suppress(Exception):
                await writer.wait_closed()
        _remove_socket(self.socket_path)
        await super()._shutdown()


def _remove_socket(path: str) -> None:
    """Remove a socket file if it exists."""
    try:
        if os.path.exists(path):
            os.unlink(path)
            logger.debug("Removed socket: %s", path)
    except OSError:
        pass

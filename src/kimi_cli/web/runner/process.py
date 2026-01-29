"""Session process management for Kimi CLI web interface."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import json
import mimetypes
import sys
import time
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

from kosong.message import ContentPart, ImageURLPart, TextPart
from loguru import logger
from PIL import Image
from PIL.Image import Image as PILImage
from pydantic import TypeAdapter
from starlette.websockets import WebSocket, WebSocketState

from kimi_cli.config import load_config
from kimi_cli.llm import ModelCapability
from kimi_cli.web.models import (
    SessionNoticeEvent,
    SessionNoticePayload,
    SessionState,
    SessionStatus,
)
from kimi_cli.web.runner.messages import new_session_status_message
from kimi_cli.web.store.sessions import load_session_by_id
from kimi_cli.wire.jsonrpc import (
    JSONRPCCancelMessage,
    JSONRPCErrorObject,
    JSONRPCErrorResponse,
    JSONRPCEventMessage,
    JSONRPCInMessage,
    JSONRPCInMessageAdapter,
    JSONRPCOutMessage,
    JSONRPCPromptMessage,
    JSONRPCRequestMessage,
    JSONRPCSuccessResponse,
)
from kimi_cli.wire.serde import deserialize_wire_message

JSONRPCOutMessageAdapter = TypeAdapter[JSONRPCOutMessage](JSONRPCOutMessage)


class SessionProcess:
    """Manages a single session's KimiCLI subprocess.

    Handles:
    - Starting/stopping the subprocess
    - Reading from stdout (wire messages from KimiCLI)
    - Writing to stdin (user input to KimiCLI)
    - Broadcasting messages to connected WebSockets

    Concurrency model:
    - `SessionProcess` is the long-lived container for a `session_id`.
      It may outlive worker restarts.
    - Liveness vs busy are separate:
      - `is_alive` / `is_running`: worker subprocess exists and has not exited.
      - `is_busy`: there is at least one in-flight prompt id.
    - WebSocket fanout supports "join while running":
      - New clients replay `wire.jsonl` history first.
      - Live messages during replay are buffered per-WS and flushed afterwards.

    Locks:
    - `_lock` guards worker lifecycle and busy state.
    - `_ws_lock` guards WebSocket state.
    """

    def __init__(self, session_id: UUID) -> None:
        """Initialize a session process."""
        self.session_id = session_id
        self._in_flight_prompt_ids: set[str] = set()
        self._status_seq = 0
        self._worker_id: str | None = None
        self._status = SessionStatus(
            session_id=self.session_id,
            state="stopped",
            seq=self._status_seq,
            worker_id=self._worker_id,
            reason=None,
            detail=None,
            updated_at=datetime.now(UTC),
        )
        self._process: asyncio.subprocess.Process | None = None
        self._websockets: set[WebSocket] = set()
        self._websocket_count = 0
        self._replay_buffers: dict[WebSocket, list[str]] = {}
        self._read_task: asyncio.Task[None] | None = None
        self._expecting_exit = False
        self._lock = asyncio.Lock()
        self._ws_lock = asyncio.Lock()
        self._sent_files: set[str] = set()

    @property
    def is_alive(self) -> bool:
        """Whether the worker subprocess exists and has not exited."""
        process = self._process
        return process is not None and process.returncode is None

    @property
    def is_running(self) -> bool:
        """Backward-compatible name: indicates worker liveness."""
        return self.is_alive

    @property
    def is_busy(self) -> bool:
        """Whether the session is currently processing a prompt."""
        return len(self._in_flight_prompt_ids) > 0

    @property
    def status(self) -> SessionStatus:
        """Current runtime status snapshot."""
        return self._status

    @property
    def websocket_count(self) -> int:
        """Get the number of connected WebSockets."""
        return self._websocket_count

    async def send_status_snapshot(self, ws: WebSocket) -> None:
        """Send the current status snapshot to a specific WebSocket."""
        await ws.send_text(new_session_status_message(self._status).model_dump_json())

    def _build_status(
        self,
        state: SessionState,
        reason: str | None,
        detail: str | None,
    ) -> SessionStatus | None:
        """Build a new status object if different from current."""
        current = self._status
        if (
            current.state == state
            and current.reason == reason
            and current.detail == detail
            and current.worker_id == self._worker_id
        ):
            return None
        self._status_seq += 1
        status = SessionStatus(
            session_id=self.session_id,
            state=state,
            seq=self._status_seq,
            worker_id=self._worker_id,
            reason=reason,
            detail=detail,
            updated_at=datetime.now(UTC),
        )
        self._status = status
        return status

    async def _emit_status(
        self,
        state: SessionState,
        *,
        reason: str | None = None,
        detail: str | None = None,
    ) -> None:
        """Emit a status update if different from current."""
        status = self._build_status(state, reason, detail)
        if status is None:
            return
        await self._broadcast(new_session_status_message(status).model_dump_json())

    async def start(
        self,
        *,
        reason: str | None = None,
        detail: str | None = None,
        restart_started_at: float | None = None,
    ) -> None:
        """Start the KimiCLI subprocess."""
        async with self._lock:
            if self.is_alive:
                if self._read_task is None or self._read_task.done():
                    self._read_task = asyncio.create_task(self._read_loop())
                return

            self._in_flight_prompt_ids.clear()
            self._expecting_exit = False
            self._worker_id = str(uuid4())

            # 16MB buffer for large messages (e.g., base64-encoded images)
            STREAM_LIMIT = 16 * 1024 * 1024

            if getattr(sys, "frozen", False):
                worker_cmd = [sys.executable, "__web-worker", str(self.session_id)]
            else:
                worker_cmd = [
                    sys.executable,
                    "-m",
                    "kimi_cli.web.runner.worker",
                    str(self.session_id),
                ]

            self._process = await asyncio.create_subprocess_exec(
                *worker_cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=STREAM_LIMIT,
            )

            self._read_task = asyncio.create_task(self._read_loop())
            if restart_started_at is not None:
                elapsed_ms = int((time.perf_counter() - restart_started_at) * 1000)
                detail = f"restart_ms={elapsed_ms}"
                await self._emit_status("idle", reason=reason or "start", detail=detail)
                await self._emit_restart_notice(reason=reason, restart_ms=elapsed_ms)
            else:
                await self._emit_status("idle", reason=reason or "start", detail=detail)

    async def stop(self) -> None:
        """Stop the session: terminate worker and close all WebSockets."""
        await self.stop_worker(reason="stop")
        await self._close_all_websockets()

    async def stop_worker(
        self,
        *,
        reason: str | None = None,
        emit_status: bool = True,
    ) -> None:
        """Stop only the worker subprocess, keeping WebSockets connected."""
        async with self._lock:
            self._expecting_exit = True
            if self._process is not None:
                if self._process.returncode is None:
                    self._process.terminate()
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=10.0)
                except TimeoutError:
                    self._process.kill()
                    await self._process.wait()
                self._process = None

            if self._read_task is not None:
                self._read_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._read_task
                self._read_task = None

            self._in_flight_prompt_ids.clear()
            self._worker_id = None
            self._expecting_exit = False
            if emit_status:
                await self._emit_status("stopped", reason=reason or "stop")

    async def restart_worker(self, *, reason: str | None = None) -> None:
        """Restart the worker subprocess without disconnecting WebSockets."""
        started_at = time.perf_counter()
        await self._emit_status("restarting", reason=reason or "restart")
        await self.stop_worker(reason="restart", emit_status=False)
        await self.start(reason=reason or "restart", restart_started_at=started_at)

    async def _emit_restart_notice(self, *, reason: str | None, restart_ms: int) -> None:
        """Emit a restart notice to all WebSockets."""
        label = "Session restarted"
        if reason == "config_update":
            label = "Session restarted due to config update"
        payload = SessionNoticePayload(
            text=f"{label} · {restart_ms}ms",
            kind="restart",
            reason=reason,
            restart_ms=restart_ms,
        )
        event = SessionNoticeEvent(payload=payload)
        await self._broadcast(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "method": "event",
                    "params": event.model_dump(mode="json"),
                },
                ensure_ascii=False,
            )
        )

    async def _read_loop(self) -> None:
        """Read messages from subprocess stdout and broadcast to WebSockets."""
        assert self._process is not None
        assert self._process.stdout is not None
        assert self._process.stderr is not None

        try:
            while True:
                line = await self._process.stdout.readline()
                if not line:
                    if self._process.stdout.at_eof():
                        if self._expecting_exit:
                            break
                        stderr = await self._process.stderr.read()
                        if not stderr:
                            stderr = b"No stderr"
                        await self._broadcast(
                            JSONRPCErrorResponse(
                                id=str(uuid4()),
                                error=JSONRPCErrorObject(
                                    code=self._process.returncode or -1,
                                    message=stderr.decode("utf-8"),
                                ),
                            ).model_dump_json()
                        )
                        logger.warning(
                            f"Process exited with {self._process.returncode}: "
                            f"{stderr.decode('utf-8')}"
                        )
                        self._in_flight_prompt_ids.clear()
                        await self._emit_status(
                            "error",
                            reason="process_exit",
                            detail=stderr.decode("utf-8"),
                        )
                        break
                    else:
                        continue

                await self._broadcast(line.decode("utf-8").rstrip("\n"))

                # Handle out message
                try:
                    msg = json.loads(line)
                    match msg.get("method"):
                        case "event":
                            msg["params"] = deserialize_wire_message(msg["params"])
                            await self._handle_out_message(JSONRPCEventMessage.model_validate(msg))
                        case "request":
                            msg["params"] = deserialize_wire_message(msg["params"])
                            await self._handle_out_message(
                                JSONRPCRequestMessage.model_validate(msg)
                            )
                        case _:
                            if msg.get("error"):
                                await self._handle_out_message(
                                    JSONRPCErrorResponse.model_validate(msg)
                                )
                            else:
                                await self._handle_out_message(
                                    JSONRPCSuccessResponse.model_validate(msg)
                                )
                except json.JSONDecodeError:
                    logger.error(f"Invalid JSONRPC out message: {line}")

        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"Unexpected error in read loop: {e.__class__.__name__} {e}")

    async def _handle_out_message(self, message: JSONRPCOutMessage) -> None:
        """Handle outbound message from worker."""
        match message:
            case JSONRPCSuccessResponse():
                was_busy = self.is_busy
                if message.id in self._in_flight_prompt_ids:
                    self._in_flight_prompt_ids.remove(message.id)
                if was_busy and not self.is_busy:
                    await self._emit_status("idle", reason="prompt_complete")
            case JSONRPCErrorResponse():
                was_busy = self.is_busy
                if message.id in self._in_flight_prompt_ids:
                    self._in_flight_prompt_ids.remove(message.id)
                if was_busy and not self.is_busy:
                    await self._emit_status("idle", reason="prompt_error")
            case _:
                return

    async def _encode_uploaded_files(self) -> AsyncGenerator[ContentPart]:
        """Encode uploaded files for sending to the model."""
        session = load_session_by_id(self.session_id)
        assert session is not None

        uploads_dir = session.kimi_cli_session.dir / "uploads"
        if not uploads_dir.exists():
            return

        all_files = sorted(uploads_dir.iterdir(), key=lambda x: x.name)
        files = [f for f in all_files if f.name not in self._sent_files]

        if not files:
            return

        # Build file list with paths and mime types
        file_infos: list[tuple[Path, str]] = []
        for file in files:
            mime_type, _ = mimetypes.guess_type(file.name)
            file_infos.append((file, mime_type or "application/octet-stream"))

        # Output file list summary
        file_list_lines = ["<uploaded_files>"]
        for idx, (file, _) in enumerate(file_infos, start=1):
            file_list_lines.append(f"{idx}. {file}")
        file_list_lines.append("</uploaded_files>")
        yield TextPart(text="\n".join(file_list_lines) + "\n\n")

        # Text file extensions
        text_extensions = {
            ".txt",
            ".md",
            ".json",
            ".yaml",
            ".yml",
            ".xml",
            ".html",
            ".css",
            ".js",
            ".ts",
            ".py",
            ".sh",
            ".csv",
            ".log",
            ".rst",
            ".toml",
            ".ini",
        }

        # Check model capabilities
        config = load_config()
        capabilities: set[ModelCapability] = set()
        if config.default_model:
            capabilities = config.models[config.default_model].capabilities or set()
        is_vision = "image_in" in capabilities
        is_video_in = "video_in" in capabilities

        # Process each file
        for file, mime_type in file_infos:
            file_path = str(file)
            ext = file.suffix.lower()

            if is_vision and mime_type.startswith("image/"):
                try:
                    content = file.read_bytes()
                    with Image.open(io.BytesIO(content)) as img:
                        pil_img: PILImage = img
                        width, height = pil_img.size
                        max_side = max(width, height)
                        if max_side > 1024:
                            scale = 1024 / max_side
                            new_size = (int(width * scale), int(height * scale))
                            pil_img = pil_img.resize(  # pyright: ignore[reportUnknownMemberType]
                                new_size
                            )
                        buffer = io.BytesIO()
                        pil_img.save(buffer, format="PNG")
                        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
                        tag = f'<image path="{file_path}" content_type="{mime_type}">'
                        yield TextPart(text=tag)
                        yield ImageURLPart(
                            image_url=ImageURLPart.ImageURL(url=f"data:image/png;base64,{encoded}")
                        )
                        yield TextPart(text="</image>\n\n")
                except Exception:
                    # Skip files that fail to encode - don't block the upload
                    pass
            elif is_video_in and mime_type.startswith("video/"):
                # For video files, emit a <video> tag for frontend display but don't embed content.
                # The agent will use ReadMediaFile tool to read it, which handles video uploads
                # properly.
                yield TextPart(text=f'<video path="{file_path}" content_type="{mime_type}">')
                yield TextPart(text="</video>\n\n")
            elif ext in text_extensions or mime_type.startswith("text/"):
                try:
                    content = file.read_bytes()
                    text_content = content.decode("utf-8", errors="replace")
                    yield TextPart(text=f'<document path="{file_path}" content_type="{mime_type}">')
                    yield TextPart(text=text_content)
                    yield TextPart(text="</document>\n\n")
                except Exception:
                    # Skip files that fail to decode - don't block the upload
                    pass

        # Mark files as sent
        for file in files:
            self._sent_files.add(file.name)

    async def _handle_in_message(self, message: JSONRPCInMessage) -> str | None:
        """Handle inbound message to worker, encoding uploaded files."""
        match message:
            case JSONRPCPromptMessage():
                user_input: list[ContentPart] = []
                async for part in self._encode_uploaded_files():
                    user_input.append(part)
                # Special marker for file-only uploads
                if isinstance(message.params.user_input, str):
                    if message.params.user_input != "KIMI_FILE_UPLOAD_WITHOUT_MESSAGE":
                        user_input.append(TextPart(text=message.params.user_input))
                else:
                    user_input += message.params.user_input
                return json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "method": "prompt",
                        "id": message.id,
                        "params": {
                            "user_input": [part.model_dump(mode="json") for part in user_input],
                        },
                    },
                    ensure_ascii=False,
                )
            case _:
                return None
        return None

    async def _broadcast(self, message: str) -> None:
        """Broadcast a message to all connected WebSockets."""
        disconnected: set[WebSocket] = set()

        async with self._ws_lock:
            websockets = list(self._websockets)
            to_send: list[WebSocket] = []
            for ws in websockets:
                buffer = self._replay_buffers.get(ws)
                if buffer is not None:
                    buffer.append(message)
                else:
                    to_send.append(ws)

        for ws in to_send:
            try:
                if ws.client_state == WebSocketState.CONNECTED:
                    await ws.send_text(message)
                else:
                    disconnected.add(ws)
            except Exception as e:
                logger.warning(f"websocket failed: {e.__class__.__name__} {e}")
                disconnected.add(ws)

        if disconnected:
            async with self._ws_lock:
                self._websockets -= disconnected
                self._websocket_count = len(self._websockets)
                for ws in disconnected:
                    self._replay_buffers.pop(ws, None)

    async def add_websocket_and_begin_replay(self, ws: WebSocket) -> None:
        """Atomically attach a WebSocket and enter replay mode for it."""
        async with self._ws_lock:
            if ws not in self._websockets:
                self._websockets.add(ws)
                self._websocket_count = len(self._websockets)
            self._replay_buffers.setdefault(ws, [])

    async def end_replay(self, ws: WebSocket) -> None:
        """Flush buffered live messages for a websocket after history replay."""
        while True:
            async with self._ws_lock:
                buffer = self._replay_buffers.get(ws)
                if buffer is None:
                    return
                if not buffer:
                    self._replay_buffers.pop(ws, None)
                    return
                chunk = buffer.copy()
                buffer.clear()

            if ws.client_state != WebSocketState.CONNECTED:
                return
            for message in chunk:
                try:
                    await ws.send_text(message)
                except Exception:
                    # WebSocket disconnected during replay - clean up
                    async with self._ws_lock:
                        if ws in self._websockets:
                            self._websockets.discard(ws)
                            self._websocket_count = len(self._websockets)
                        self._replay_buffers.pop(ws, None)
                    return

    async def _close_all_websockets(self) -> None:
        """Close all connected WebSockets."""
        async with self._ws_lock:
            websockets = list(self._websockets)
            self._websockets.clear()
            self._websocket_count = 0
            self._replay_buffers.clear()

        for ws in websockets:
            try:
                if ws.client_state == WebSocketState.CONNECTED:
                    await ws.close(code=1001, reason="Session process exited")
            except Exception:
                # Ignore errors closing already-disconnected WebSockets
                pass

    async def remove_websocket(self, ws: WebSocket) -> None:
        """Remove a WebSocket connection from this session."""
        async with self._ws_lock:
            if ws in self._websockets:
                self._websockets.discard(ws)
                self._websocket_count = len(self._websockets)
            self._replay_buffers.pop(ws, None)

    async def send_message(self, message: str) -> None:
        """Send a message to the subprocess stdin."""
        await self.start()
        process = self._process
        assert process is not None
        assert process.stdin is not None

        # Handle in message
        try:
            in_message = JSONRPCInMessageAdapter.validate_json(message)
            if isinstance(in_message, JSONRPCPromptMessage):
                was_busy = self.is_busy
                self._in_flight_prompt_ids.add(in_message.id)
                if not was_busy:
                    await self._emit_status("busy", reason="prompt")
            elif isinstance(in_message, JSONRPCCancelMessage) and not self.is_busy:
                # If not busy, return success to avoid errors
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

        process.stdin.write((message + "\n").encode("utf-8"))
        await process.stdin.drain()


class KimiCLIRunner:
    """Manages multiple session processes."""

    def __init__(self) -> None:
        """Initialize the runner."""
        self._sessions: dict[UUID, SessionProcess] = {}
        self._lock = asyncio.Lock()

    def start(self) -> None:
        """Start the runner (no-op, sessions started on demand)."""
        pass

    def stop(self) -> None:
        """Stop all running sessions."""
        for session in self._sessions.values():
            if session.is_running:
                asyncio.create_task(session.stop())

    async def get_or_create_session(self, session_id: UUID) -> SessionProcess:
        """Get or create a session process."""
        async with self._lock:
            if session_id not in self._sessions:
                self._sessions[session_id] = SessionProcess(session_id)
            return self._sessions[session_id]

    def get_session(self, session_id: UUID) -> SessionProcess | None:
        """Get a session process if it exists."""
        return self._sessions.get(session_id)

    async def detach_websocket(self, ws: WebSocket, session_id: UUID) -> None:
        """Detach a WebSocket from a session."""
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                await session.remove_websocket(ws)

"""JSON-RPC message helpers for Kimi CLI web interface."""

from typing import Literal
from uuid import uuid4

from fastapi import WebSocket
from pydantic import BaseModel, ConfigDict
from starlette.websockets import WebSocketState

from kimi_cli.web.models import SessionStatus


class _MessageBase(BaseModel):
    """Base model for JSON-RPC messages."""

    jsonrpc: Literal["2.0"] = "2.0"
    model_config = ConfigDict(extra="forbid")


class JSONRPCSessionStatusMessage(_MessageBase):
    """Session status update message."""

    method: Literal["session_status"] = "session_status"
    params: SessionStatus


class JSONRPCHistoryCompleteMessage(_MessageBase):
    """Sent after history replay, before environment is ready."""

    method: Literal["history_complete"] = "history_complete"
    id: str


def new_session_status_message(status: SessionStatus) -> JSONRPCSessionStatusMessage:
    """Create a new session status message."""
    return JSONRPCSessionStatusMessage(params=status)


def new_history_complete_message() -> JSONRPCHistoryCompleteMessage:
    """Create a new history complete message."""
    return JSONRPCHistoryCompleteMessage(id=str(uuid4()))


async def send_history_complete(ws: WebSocket) -> bool:
    """Send history complete message to a WebSocket.

    Returns:
        True if message was sent successfully, False if the send fails or the WebSocket is not
        connected.
    """
    if ws.client_state != WebSocketState.CONNECTED:
        return False
    try:
        await ws.send_text(new_history_complete_message().model_dump_json())
        return True
    except Exception:
        return False

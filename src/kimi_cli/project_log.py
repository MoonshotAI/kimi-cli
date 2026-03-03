"""Session logging for Kimi Code CLI.

This module creates logs in ~/.kimi/sessions/<work-dir-hash>/<session-id>/logs/
to capture session events, user prompts, and thinking content.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import aiofiles
from kosong.message import ThinkPart

from kimi_cli.utils.logging import logger
from kimi_cli.wire.types import (
    ApprovalRequest,
    StepBegin,
    TextPart,
    ToolCall,
    ToolResult,
    TurnBegin,
    TurnEnd,
    WireMessage,
)


def get_session_log_dir(session_dir: Path) -> Path:
    """Get the log directory for a session (inside ~/.kimi/sessions/)."""
    return session_dir / "logs"


def ensure_session_log_dir(session_dir: Path) -> Path:
    """Ensure the session log directory exists."""
    log_dir = get_session_log_dir(session_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


@dataclass(frozen=True, slots=True)
class SessionStartEvent:
    """Logged when a session starts."""

    session_id: str
    cwd: str
    event_type: Literal["SessionStart"] = "SessionStart"
    timestamp: str | None = None

    def __post_init__(self):
        if self.timestamp is None:
            object.__setattr__(
                self,
                "timestamp",
                datetime.now(timezone.utc).isoformat(),
            )


@dataclass(frozen=True, slots=True)
class SessionEndEvent:
    """Logged when a session ends."""

    session_id: str
    cwd: str
    reason: str
    event_type: Literal["SessionEnd"] = "SessionEnd"
    timestamp: str | None = None

    def __post_init__(self):
        if self.timestamp is None:
            object.__setattr__(
                self,
                "timestamp",
                datetime.now(timezone.utc).isoformat(),
            )


@dataclass(frozen=True, slots=True)
class UserPromptEvent:
    """Logged when a user submits a prompt."""

    session_id: str
    cwd: str
    prompt: str
    event_type: Literal["UserPromptSubmit"] = "UserPromptSubmit"
    timestamp: str | None = None

    def __post_init__(self):
        if self.timestamp is None:
            object.__setattr__(
                self,
                "timestamp",
                datetime.now(timezone.utc).isoformat(),
            )


@dataclass(frozen=True, slots=True)
class ThinkingEvent:
    """Logged when the model generates thinking content."""

    session_id: str
    cwd: str
    thinking: str
    step_number: int
    event_type: Literal["Thinking"] = "Thinking"
    timestamp: str | None = None

    def __post_init__(self):
        if self.timestamp is None:
            object.__setattr__(
                self,
                "timestamp",
                datetime.now(timezone.utc).isoformat(),
            )


@dataclass(frozen=True, slots=True)
class ToolCallEvent:
    """Logged when a tool is called."""

    session_id: str
    cwd: str
    tool_name: str
    arguments: dict[str, Any]
    event_type: Literal["ToolCall"] = "ToolCall"
    timestamp: str | None = None

    def __post_init__(self):
        if self.timestamp is None:
            object.__setattr__(
                self,
                "timestamp",
                datetime.now(timezone.utc).isoformat(),
            )


@dataclass(frozen=True, slots=True)
class ToolResultEvent:
    """Logged when a tool returns a result."""

    session_id: str
    cwd: str
    tool_name: str
    success: bool
    event_type: Literal["ToolResult"] = "ToolResult"
    timestamp: str | None = None

    def __post_init__(self):
        if self.timestamp is None:
            object.__setattr__(
                self,
                "timestamp",
                datetime.now(timezone.utc).isoformat(),
            )


@dataclass(frozen=True, slots=True)
class ApprovalRequestEvent:
    """Logged when an approval is requested."""

    session_id: str
    cwd: str
    action: str
    description: str
    event_type: Literal["ApprovalRequest"] = "ApprovalRequest"
    timestamp: str | None = None

    def __post_init__(self):
        if self.timestamp is None:
            object.__setattr__(
                self,
                "timestamp",
                datetime.now(timezone.utc).isoformat(),
            )


LogEvent = (
    SessionStartEvent
    | SessionEndEvent
    | UserPromptEvent
    | ThinkingEvent
    | ToolCallEvent
    | ToolResultEvent
    | ApprovalRequestEvent
)


class SessionLogger:
    """Logger that writes events to ~/.kimi/sessions/<hash>/<session>/logs/ directory."""

    def __init__(
        self,
        work_dir: Path,
        session_id: str,
        session_dir: Path,
    ):
        self._work_dir = work_dir
        self._session_id = session_id
        self._session_dir = session_dir
        self._log_dir = ensure_session_log_dir(session_dir)
        self._current_step = 0
        self._pending_thinking_parts: list[str] = []

    def _make_cwd(self) -> str:
        return str(self._work_dir)

    async def _append_to_log(self, filename: str, event: LogEvent) -> None:
        """Append a single event to a JSONL log file."""
        log_file = self._log_dir / filename
        try:
            async with aiofiles.open(log_file, "a", encoding="utf-8") as f:
                await f.write(json.dumps(asdict(event), ensure_ascii=False) + "\n")
        except Exception:
            logger.exception("Failed to write to session log file: {file}", file=log_file)

    async def log_session_start(self) -> None:
        """Log session start event."""
        event = SessionStartEvent(
            session_id=self._session_id,
            cwd=self._make_cwd(),
        )
        await self._append_to_log("session_start.jsonl", event)

    async def log_session_end(self, reason: str = "unknown") -> None:
        """Log session end event."""
        event = SessionEndEvent(
            session_id=self._session_id,
            cwd=self._make_cwd(),
            reason=reason,
        )
        await self._append_to_log("session_end.jsonl", event)

    async def log_user_prompt(self, prompt: str) -> None:
        """Log user prompt submission."""
        event = UserPromptEvent(
            session_id=self._session_id,
            cwd=self._make_cwd(),
            prompt=prompt,
        )
        await self._append_to_log("user_prompt_submit.jsonl", event)

    async def log_thinking(self, thinking_content: str) -> None:
        """Log thinking content."""
        event = ThinkingEvent(
            session_id=self._session_id,
            cwd=self._make_cwd(),
            thinking=thinking_content,
            step_number=self._current_step,
        )
        await self._append_to_log("thinking.jsonl", event)

    async def log_tool_call(self, tool_name: str, arguments: dict[str, Any]) -> None:
        """Log a tool call."""
        event = ToolCallEvent(
            session_id=self._session_id,
            cwd=self._make_cwd(),
            tool_name=tool_name,
            arguments=arguments,
        )
        await self._append_to_log("tool_calls.jsonl", event)

    async def log_tool_result(self, tool_name: str, success: bool) -> None:
        """Log a tool result."""
        event = ToolResultEvent(
            session_id=self._session_id,
            cwd=self._make_cwd(),
            tool_name=tool_name,
            success=success,
        )
        await self._append_to_log("tool_results.jsonl", event)

    async def log_approval_request(self, action: str, description: str) -> None:
        """Log an approval request."""
        event = ApprovalRequestEvent(
            session_id=self._session_id,
            cwd=self._make_cwd(),
            action=action,
            description=description,
        )
        await self._append_to_log("approval_requests.jsonl", event)

    def set_step_number(self, step_number: int) -> None:
        """Update the current step number."""
        self._current_step = step_number

    def collect_thinking_part(self, thinking: str) -> None:
        """Collect a thinking part to be logged later."""
        self._pending_thinking_parts.append(thinking)

    async def flush_thinking(self) -> None:
        """Flush collected thinking parts to the log."""
        if self._pending_thinking_parts:
            combined = "".join(self._pending_thinking_parts)
            await self.log_thinking(combined)
            self._pending_thinking_parts.clear()

    def clear_thinking(self) -> None:
        """Clear pending thinking without logging."""
        self._pending_thinking_parts.clear()


class SessionLogRecorder:
    """Records wire events to session logs in ~/.kimi/sessions/."""

    def __init__(
        self,
        logger: SessionLogger,
    ):
        self._logger = logger
        self._task: asyncio.Task[None] | None = None
        self._queue: asyncio.Queue[WireMessage] = asyncio.Queue()

    def start(self) -> None:
        """Start the recorder in a background task."""
        if self._task is None:
            self._task = asyncio.create_task(self._consume_loop())

    async def stop(self) -> None:
        """Stop the recorder."""
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def send(self, msg: WireMessage) -> None:
        """Send a message to be logged."""
        try:
            self._queue.put_nowait(msg)
        except asyncio.QueueFull:
            logger.warning("Session log queue is full, dropping message")

    async def _consume_loop(self) -> None:
        """Consume messages from the queue and log them."""
        while True:
            try:
                msg = await self._queue.get()
                await self._process_message(msg)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Error processing session log message")

    async def _process_message(self, msg: WireMessage) -> None:
        """Process a single wire message."""
        match msg:
            case TurnBegin(user_input=user_input):
                # Log user prompt
                if isinstance(user_input, str):
                    await self._logger.log_user_prompt(user_input)
                else:
                    # Extract text from content parts
                    texts: list[str] = []
                    for part in user_input:
                        if isinstance(part, TextPart):
                            texts.append(part.text)
                    if texts:
                        await self._logger.log_user_prompt("".join(texts))

            case StepBegin(n=step_number):
                # Flush any pending thinking before step changes
                await self._logger.flush_thinking()
                self._logger.set_step_number(step_number)

            case ThinkPart(text=thinking_text) if isinstance(thinking_text, str):
                # Collect thinking parts
                self._logger.collect_thinking_part(thinking_text)

            case ToolCall(function=function):
                # Log tool call
                func_name = function.name if hasattr(function, "name") else "unknown"
                func_args = function.arguments if hasattr(function, "arguments") else None
                try:
                    args: dict[str, Any] = json.loads(func_args) if func_args else {}
                except json.JSONDecodeError:
                    args = {"raw": func_args}
                await self._logger.log_tool_call(func_name, args)

            case ToolResult(tool_name=tool_name, return_value=return_value):
                # Log tool result - success if not an error
                from kosong.tooling import ToolError
                tname = tool_name if isinstance(tool_name, str) else "unknown"
                is_success = not isinstance(return_value, ToolError)
                await self._logger.log_tool_result(tname, is_success)

            case ApprovalRequest(action=action, description=description):
                # Log approval request
                act = action if isinstance(action, str) else "unknown"
                desc = description if isinstance(description, str) else ""
                await self._logger.log_approval_request(act, desc)

            case TurnEnd():
                # Flush any pending thinking at turn end
                await self._logger.flush_thinking()
            case _:
                # Ignore other message types
                pass


# Global session logger for current session
_current_session_logger: SessionLogger | None = None
_current_session_recorder: SessionLogRecorder | None = None


def get_session_logger() -> SessionLogger | None:
    """Get the current session logger, if any."""
    return _current_session_logger


def setup_session_logging(
    work_dir: Path,
    session_id: str,
    session_dir: Path,
) -> SessionLogRecorder:
    """Set up session logging for the current session.
    
    Returns the recorder that should be sent wire messages.
    """
    global _current_session_logger, _current_session_recorder

    _current_session_logger = SessionLogger(work_dir, session_id, session_dir)
    _current_session_recorder = SessionLogRecorder(_current_session_logger)

    return _current_session_recorder


def cleanup_session_logging() -> None:
    """Clean up session logging resources."""
    global _current_session_logger, _current_session_recorder

    if _current_session_recorder is not None:
        # Note: async cleanup should be handled by the caller
        pass

    _current_session_logger = None
    _current_session_recorder = None

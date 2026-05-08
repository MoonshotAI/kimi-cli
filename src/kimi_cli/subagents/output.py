"""Unified output writer for subagent executions (foreground and background)."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from kosong.message import TextPart, ToolCall, ToolCallPart
from kosong.tooling import ToolResult


class SubagentOutputWriter:
    """Appends human-readable transcript lines to one or more output files.

    Both foreground and background runners use this so the output format
    is identical regardless of execution mode.  When *extra_paths* are
    provided every write is tee'd to those files as well (used by the
    background agent runner to keep the task ``output.log`` in sync with
    the canonical subagent output).
    """

    def __init__(self, path: Path, *, extra_paths: Sequence[Path] = ()) -> None:
        self._path = path
        self._extra_paths = extra_paths

    def stage(self, name: str) -> None:
        self._append(f"[stage] {name}\n")

    def tool_call(self, tc: ToolCall) -> None:
        name = tc.function.name if tc.function else "?"
        self._append(f"[tool] {name}\n")

    def tool_result(self, tr: ToolResult) -> None:
        status = "error" if tr.return_value.is_error else "success"
        brief = getattr(tr.return_value, "brief", None)
        if brief:
            self._append(f"[tool_result] {status}: {brief}\n")
        else:
            self._append(f"[tool_result] {status}\n")

    def text(self, text: str) -> None:
        if text:
            self._append(text)

    def summary(self, text: str) -> None:
        if text:
            self._append(f"\n[summary]\n{text}\n")

    def error(self, message: str) -> None:
        self._append(f"[error] {message}\n")

    def write_wire_message(self, msg: object) -> None:
        """Dispatch a wire message to the appropriate writer method."""
        if isinstance(msg, TextPart):
            self.text(msg.text)
        elif isinstance(msg, ToolCall):
            self.tool_call(msg)
        elif isinstance(msg, ToolResult):
            self.tool_result(msg)
        elif isinstance(msg, ToolCallPart):
            pass  # incremental argument chunks — not useful in transcript

    def _append(self, text: str) -> None:
        with self._path.open("a", encoding="utf-8") as f:
            f.write(text)
        for p in self._extra_paths:
            try:
                with p.open("a", encoding="utf-8") as f:
                    f.write(text)
            except OSError:
                pass  # best-effort — never interrupt the agent for a tee failure

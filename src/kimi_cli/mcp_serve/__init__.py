from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import Any

from fastmcp import FastMCP
from kaos.path import KaosPath

from kimi_cli.app import KimiCLI, enable_logging
from kimi_cli.config import load_config
from kimi_cli.session import Session
from kimi_cli.utils.logging import logger
from kimi_cli.wire.types import (
    ContentPart,
    StepBegin,
    StepInterrupted,
    ToolCall,
    ToolCallPart,
    ToolResult,
    WireMessage,
)

server = FastMCP("kimi-code-cli")


def _parse_tool_args(func: Any) -> dict[str, Any]:
    """Extract arguments dict from a ToolCall function body."""
    if func is None:
        return {}
    raw_args = getattr(func, "arguments", None)
    if isinstance(raw_args, dict):
        return raw_args  # type: ignore[reportUnknownVariableType]
    if isinstance(raw_args, str):
        import json

        with contextlib.suppress(json.JSONDecodeError):
            parsed = json.loads(raw_args)
            if isinstance(parsed, dict):
                return parsed  # type: ignore[reportUnknownVariableType]
    return {}


class _ResultCollector:
    """Collects Wire messages into a structured result."""

    def __init__(self) -> None:
        self.text_parts: list[str] = []
        self.tool_calls: list[dict[str, Any]] = []
        self.current_tool_call: dict[str, Any] | None = None

    def feed(self, msg: WireMessage) -> None:
        match msg:
            case ContentPart() as part:
                text = getattr(part, "text", None)
                if text:
                    self.text_parts.append(text)
            case ToolCall() as call:
                func = getattr(call, "function", None)
                args = _parse_tool_args(func)
                if func is not None:
                    name = getattr(func, "name", "unknown") or "unknown"
                else:
                    name = "unknown"
                self.current_tool_call = {
                    "id": getattr(call, "id", ""),
                    "name": name,
                    "args": args,
                }
                self.tool_calls.append(self.current_tool_call)
            case ToolCallPart() as part:
                if self.current_tool_call is not None:
                    raw_args = getattr(part, "arguments_part", None)
                    if isinstance(raw_args, dict):
                        self.current_tool_call["args"] = raw_args
                    elif isinstance(raw_args, str):
                        import json

                        with contextlib.suppress(json.JSONDecodeError):
                            parsed = json.loads(raw_args)
                            if isinstance(parsed, dict):
                                self.current_tool_call["args"] = parsed
            case ToolResult() as result:
                tool_call_id = getattr(result, "tool_call_id", None)
                return_value = getattr(result, "return_value", None)
                is_error = (
                    getattr(return_value, "is_error", False) if return_value is not None else False
                )
                for tc in self.tool_calls:
                    if tc.get("id") == tool_call_id:
                        tc["done"] = True
                        tc["success"] = not is_error
                        break
            case StepBegin():
                self.text_parts.clear()
            case _:
                pass

    def build_result(self) -> str:
        response = "".join(self.text_parts).strip()

        if not self.tool_calls:
            return response or "(no response)"

        lines: list[str] = []
        if response:
            lines.append(response)
            lines.append("")

        lines.append("**Actions taken:**")
        for tc in self.tool_calls:
            name = tc.get("name", "unknown")
            args = tc.get("args", {})
            done = tc.get("done", False)
            success = tc.get("success", False)
            args_str = " ".join(f"{k}={v!r}" for k, v in args.items()) if args else ""
            status = "✓" if done and success else "✗" if done else "…"
            lines.append(f"- {status} `{name}` {args_str}")

        return "\n".join(lines)


async def _run_kimi_agent(task: str, working_directory: str | None = None) -> str:
    """Core implementation of the kimi_agent tool."""
    if not task.strip():
        return "Error: task cannot be empty."

    cwd = Path(working_directory).resolve() if working_directory else Path.cwd()
    if not cwd.is_dir():
        return f"Error: working_directory '{cwd}' is not a valid directory."

    config = load_config()
    # Disable auto-Ralph for one-shot MCP tool execution.
    config.loop_control.max_ralph_iterations = 0
    session = await Session.create(work_dir=KaosPath(str(cwd)))

    try:
        kimi = await KimiCLI.create(
            session=session,
            config=config,
            yolo=True,
        )
    except Exception as e:
        logger.exception("Failed to create KimiCLI:")
        await session.delete()
        return f"Error initializing Kimi agent: {e}"

    cancel_event = asyncio.Event()
    collector = _ResultCollector()

    interrupted = False
    try:
        async for msg in kimi.run(task, cancel_event):
            collector.feed(msg)
            if isinstance(msg, StepInterrupted):
                interrupted = True
                # Do not break here; the underlying exception is re-raised
                # immediately after StepInterrupted is emitted, and we need
                # it to propagate out of the async iterator so callers see
                # the real failure instead of a partial success.
    except asyncio.CancelledError:
        return "Task was cancelled."
    except Exception as e:
        logger.exception("Error during Kimi agent execution:")
        if interrupted:
            return (
                f"Error: Agent step was interrupted.\n\n"
                f"{collector.build_result()}\n\n"
                f"Underlying error: {e}"
            )
        return f"Error during execution: {e}"
    else:
        if interrupted:
            return f"Error: Agent step was interrupted.\n\n{collector.build_result()}\n\n"
    finally:
        await kimi.shutdown_background_tasks()
        await session.delete()

    return collector.build_result()


@server.tool()
async def kimi_agent(
    task: str,
    working_directory: str | None = None,
) -> str:
    """Delegate a software engineering task to the Kimi Code CLI agent.

    Kimi is a terminal-based AI agent with tools for shell execution,
    file operations, web search, subagents, and more. Use this when you
    need deep workspace analysis, multi-file edits, command execution,
    or autonomous agentic workflows.

    Args:
        task: Natural language description of the task to perform.
        working_directory: Absolute path to the directory where the task
            should run. Defaults to the current working directory.
    """
    return await _run_kimi_agent(task, working_directory)


def run_mcp_server() -> None:
    """Entry point for `kimi mcp serve`."""
    enable_logging(debug=False, redirect_stderr=True)
    server.run(transport="stdio")

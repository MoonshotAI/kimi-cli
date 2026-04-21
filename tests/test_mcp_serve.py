from __future__ import annotations

from pathlib import Path

import pytest
from kosong.message import TextPart, ToolCall
from kosong.tooling import ToolResult, ToolReturnValue

from kimi_cli.mcp_serve import _ResultCollector, _run_kimi_agent, server
from kimi_cli.wire.types import StepBegin


class TestResultCollector:
    def test_empty(self) -> None:
        collector = _ResultCollector()
        assert collector.build_result() == "(no response)"

    def test_text_only(self) -> None:
        collector = _ResultCollector()
        part = TextPart(text="Hello world")
        collector.feed(part)
        assert collector.build_result() == "Hello world"

    def test_step_begin_clears_text(self) -> None:
        collector = _ResultCollector()
        collector.feed(TextPart(text="old"))
        collector.feed(StepBegin(n=1))
        collector.feed(TextPart(text="new"))
        assert collector.build_result() == "new"

    def test_tool_call_tracked(self) -> None:
        collector = _ResultCollector()
        collector.feed(
            ToolCall(
                id="1",
                function=ToolCall.FunctionBody(name="shell", arguments='{"command": "ls"}'),
            )
        )
        collector.feed(
            ToolResult(
                tool_call_id="1",
                return_value=ToolReturnValue(
                    is_error=False, output="file.txt", message="", display=[]
                ),
            )
        )
        result = collector.build_result()
        assert "shell" in result
        assert "✓" in result

    def test_tool_call_error(self) -> None:
        collector = _ResultCollector()
        collector.feed(
            ToolCall(
                id="1",
                function=ToolCall.FunctionBody(name="shell", arguments='{"command": "bad"}'),
            )
        )
        collector.feed(
            ToolResult(
                tool_call_id="1",
                return_value=ToolReturnValue(is_error=True, output="", message="error", display=[]),
            )
        )
        result = collector.build_result()
        assert "✗" in result


class TestMCPServer:
    def test_server_has_kimi_agent_tool(self) -> None:
        tools = [t.name for t in server._tool_manager._tools.values()]
        assert "kimi_agent" in tools


class TestRunKimiAgent:
    @pytest.mark.asyncio
    async def test_empty_task(self) -> None:
        result = await _run_kimi_agent("   ")
        assert "cannot be empty" in result

    @pytest.mark.asyncio
    async def test_invalid_directory(self) -> None:
        result = await _run_kimi_agent("hello", working_directory="/nonexistent/path/12345")
        assert "not a valid directory" in result

    @pytest.mark.asyncio
    async def test_simple_task(self) -> None:
        """End-to-end test with a real Kimi agent run."""
        result = await _run_kimi_agent(
            "What is your name? Reply in one sentence.",
            working_directory=str(Path.cwd()),
        )
        assert not result.startswith("Error:")
        assert len(result) > 0
        assert "Kimi" in result or "kimi" in result.lower()

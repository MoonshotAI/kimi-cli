"""Tests for diagnostic logging: logger calls at key error paths and export bundling."""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

from pydantic import SecretStr

from kimi_cli.cli.export import _collect_recent_log_files, _session_time_range

_TWO_DAYS = 2 * 24 * 60 * 60


def _write_wire_records(wire_path: Path, timestamps: list[float]) -> None:
    """Write minimal wire.jsonl with given timestamps."""
    with wire_path.open("w") as f:
        # metadata line
        f.write(json.dumps({"type": "metadata", "protocol_version": "1"}) + "\n")
        for ts in timestamps:
            record = {
                "timestamp": ts,
                "message": {
                    "type": "TurnBegin",
                    "payload": {"user_input": [{"type": "text", "text": "hi"}]},
                },
            }
            f.write(json.dumps(record) + "\n")


# ---------------------------------------------------------------------------
# _session_time_range
# ---------------------------------------------------------------------------


class TestSessionTimeRange:
    def test_returns_first_and_last(self, tmp_path: Path):
        wire = tmp_path / "wire.jsonl"
        _write_wire_records(wire, [1000.0, 2000.0, 3000.0])
        first, last = _session_time_range(tmp_path)
        assert first == 1000.0
        assert last == 3000.0

    def test_single_record(self, tmp_path: Path):
        wire = tmp_path / "wire.jsonl"
        _write_wire_records(wire, [5000.0])
        first, last = _session_time_range(tmp_path)
        assert first == 5000.0
        assert last == 5000.0

    def test_no_wire_file(self, tmp_path: Path):
        first, last = _session_time_range(tmp_path)
        assert first is None
        assert last is None

    def test_empty_wire_file(self, tmp_path: Path):
        (tmp_path / "wire.jsonl").write_text("")
        first, last = _session_time_range(tmp_path)
        assert first is None
        assert last is None


# ---------------------------------------------------------------------------
# _collect_recent_log_files
# ---------------------------------------------------------------------------


class TestCollectRecentLogFiles:
    """Test that _collect_recent_log_files picks up the right files."""

    def _setup_log_dir(self, share_dir: Path) -> Path:
        log_dir = share_dir / "logs"
        log_dir.mkdir(parents=True)
        return log_dir

    def _make_log(self, log_dir: Path, name: str, mtime: float) -> Path:
        f = log_dir / name
        f.write_text(f"log content for {name}")
        os.utime(f, (mtime, mtime))
        return f

    def test_collects_logs_near_export_time(self, tmp_path: Path):
        """Group 2: files with mtime within 2 days of now."""
        log_dir = self._setup_log_dir(tmp_path)
        now = time.time()
        self._make_log(log_dir, "kimi.log", now - 3600)  # 1 hour ago
        self._make_log(log_dir, "kimi.old.log", now - 10 * 86400)  # 10 days ago

        session_dir = tmp_path / "session"
        session_dir.mkdir()

        with patch("kimi_cli.share.get_share_dir", return_value=tmp_path):
            files = _collect_recent_log_files(session_dir)

        names = {f.name for f in files}
        assert "kimi.log" in names
        assert "kimi.old.log" not in names

    def test_collects_logs_near_session_time(self, tmp_path: Path):
        """Group 1: files near session's active period, even if old relative to now."""
        log_dir = self._setup_log_dir(tmp_path)
        now = time.time()
        session_time = now - 7 * 86400  # session was 7 days ago

        # This log was written during the session — old relative to now, but near session
        self._make_log(log_dir, "kimi.session-era.log", session_time + 3600)
        # This log is way too old (30 days before session)
        self._make_log(log_dir, "kimi.ancient.log", session_time - 30 * 86400)
        # Current log (near export time)
        self._make_log(log_dir, "kimi.log", now - 60)

        session_dir = tmp_path / "session"
        session_dir.mkdir()
        _write_wire_records(session_dir / "wire.jsonl", [session_time, session_time + 7200])

        with patch("kimi_cli.share.get_share_dir", return_value=tmp_path):
            files = _collect_recent_log_files(session_dir)

        names = {f.name for f in files}
        assert "kimi.session-era.log" in names  # group 1: near session
        assert "kimi.log" in names  # group 2: near export
        assert "kimi.ancient.log" not in names  # too old for both groups

    def test_no_wire_file_falls_back_to_export_time(self, tmp_path: Path):
        """Without wire.jsonl, only group 2 (export time) applies."""
        log_dir = self._setup_log_dir(tmp_path)
        now = time.time()
        self._make_log(log_dir, "kimi.log", now - 3600)
        self._make_log(log_dir, "kimi.old.log", now - 5 * 86400)

        session_dir = tmp_path / "session"
        session_dir.mkdir()
        # No wire.jsonl

        with patch("kimi_cli.share.get_share_dir", return_value=tmp_path):
            files = _collect_recent_log_files(session_dir)

        names = {f.name for f in files}
        assert "kimi.log" in names
        assert "kimi.old.log" not in names

    def test_ignores_non_log_files(self, tmp_path: Path):
        log_dir = self._setup_log_dir(tmp_path)
        (log_dir / "kimi.log").write_text("log")
        (log_dir / ".DS_Store").write_bytes(b"\x00")
        (log_dir / "notes.txt").write_text("not a log")

        session_dir = tmp_path / "session"
        session_dir.mkdir()

        with patch("kimi_cli.share.get_share_dir", return_value=tmp_path):
            files = _collect_recent_log_files(session_dir)

        names = {f.name for f in files}
        assert names == {"kimi.log"}

    def test_empty_log_dir(self, tmp_path: Path):
        self._setup_log_dir(tmp_path)
        session_dir = tmp_path / "session"
        session_dir.mkdir()

        with patch("kimi_cli.share.get_share_dir", return_value=tmp_path):
            assert _collect_recent_log_files(session_dir) == []

    def test_no_log_dir(self, tmp_path: Path):
        session_dir = tmp_path / "session"
        session_dir.mkdir()

        with patch("kimi_cli.share.get_share_dir", return_value=tmp_path):
            assert _collect_recent_log_files(session_dir) == []


# ---------------------------------------------------------------------------
# Logger calls at key error paths
# ---------------------------------------------------------------------------


class TestToolExecutionLogging:
    """Test that tool execution errors produce WARNING+ logs."""

    async def test_toolset_tool_execution_error_logged(self):
        """When a tool raises an exception, toolset should log an ERROR."""
        from kimi_cli.hooks.engine import HookEngine
        from kimi_cli.soul.toolset import KimiToolset
        from kimi_cli.wire.types import ToolCall

        toolset = KimiToolset()
        toolset._hook_engine = HookEngine([], cwd="/tmp")

        class FailingTool:
            name = "FailingTool"
            base = None

            async def call(self, arguments):
                raise RuntimeError("Tool exploded")

        toolset._tool_dict["FailingTool"] = FailingTool()  # type: ignore[assignment]

        tool_call = ToolCall(
            id="tc_1",
            function=ToolCall.FunctionBody(name="FailingTool", arguments="{}"),
        )

        with patch("kimi_cli.soul.toolset.logger") as mock_logger:
            result = toolset.handle(tool_call)
            if isinstance(result, asyncio.Task):
                await result
            mock_logger.exception.assert_called()
            assert "FailingTool" in str(mock_logger.exception.call_args)

    async def test_toolset_json_parse_error_logged(self):
        """When tool call arguments are invalid JSON, toolset should log a WARNING."""
        from kimi_cli.soul.toolset import KimiToolset
        from kimi_cli.wire.types import ToolCall

        toolset = KimiToolset()

        class DummyTool:
            name = "DummyTool"
            base = None

        toolset._tool_dict["DummyTool"] = DummyTool()  # type: ignore[assignment]

        tool_call = ToolCall(
            id="tc_2",
            function=ToolCall.FunctionBody(name="DummyTool", arguments="{invalid json}"),
        )

        with patch("kimi_cli.soul.toolset.logger") as mock_logger:
            toolset.handle(tool_call)
            mock_logger.warning.assert_called()
            assert "DummyTool" in str(mock_logger.warning.call_args)


class TestFileToolLogging:
    """Test that file tool errors produce WARNING logs."""

    async def test_read_file_exception_logged(self, read_file_tool):
        from kimi_cli.tools.file.read import Params

        with (
            patch("kimi_cli.tools.file.read.logger") as mock_logger,
            patch("kimi_cli.tools.file.read.kaos_path_from_user_input") as mock_path,
        ):
            mock_path.side_effect = RuntimeError("Unexpected")
            result = await read_file_tool(Params(path="/some/file"))
            assert result.is_error
            mock_logger.warning.assert_called_once()

    async def test_write_file_exception_logged(self, write_file_tool):
        from kimi_cli.tools.file.write import Params

        with (
            patch("kimi_cli.tools.file.write.logger") as mock_logger,
            patch("kimi_cli.tools.file.write.kaos_path_from_user_input") as mock_path,
        ):
            mock_path.side_effect = RuntimeError("Unexpected")
            result = await write_file_tool(Params(path="/some/file", content="test"))
            assert result.is_error
            mock_logger.warning.assert_called_once()

    async def test_glob_exception_logged(self, glob_tool):
        from kimi_cli.tools.file.glob import Params

        with (
            patch("kimi_cli.tools.file.glob.logger") as mock_logger,
            patch("kimi_cli.tools.file.glob.kaos_path_from_user_input") as mock_path,
        ):
            mock_path.side_effect = RuntimeError("Unexpected")
            result = await glob_tool(Params(pattern="*.py", directory="/some/dir"))
            assert result.is_error
            mock_logger.warning.assert_called_once()

    async def test_replace_file_exception_logged(self, str_replace_file_tool):
        from kimi_cli.tools.file.replace import Edit, Params

        with (
            patch("kimi_cli.tools.file.replace.logger") as mock_logger,
            patch("kimi_cli.tools.file.replace.kaos_path_from_user_input") as mock_path,
        ):
            mock_path.side_effect = RuntimeError("Unexpected")
            result = await str_replace_file_tool(
                Params(path="/some/file", edit=Edit(old="a", new="b"))
            )
            assert result.is_error
            mock_logger.warning.assert_called_once()


class TestSearchWebLogging:
    async def test_search_timeout_logged(self, search_web_tool):
        from kimi_cli.tools.web.search import Params
        from tests.conftest import tool_call_context

        with (
            tool_call_context("SearchWeb"),
            patch("kimi_cli.tools.web.search.logger") as mock_logger,
            patch("kimi_cli.tools.web.search.new_client_session") as mock_session,
        ):
            mock_session.return_value.__aenter__ = AsyncMock(side_effect=TimeoutError())
            result = await search_web_tool(Params(query="test query"))
            assert result.is_error
            mock_logger.warning.assert_called()


class TestLLMLogging:
    def test_create_llm_missing_config_logged(self):
        from kimi_cli.config import LLMModel, LLMProvider

        with patch("kimi_cli.llm.logger") as mock_logger:
            from kimi_cli.llm import create_llm

            result = create_llm(
                LLMProvider(type="kimi", base_url="", api_key=SecretStr("")),
                LLMModel(provider="kimi", model="", max_context_size=100_000),
            )
            assert result is None
            mock_logger.warning.assert_called_once()


class TestSubagentRunnerLogging:
    async def test_max_steps_reached_logged(self):
        from kimi_cli.soul import MaxStepsReached
        from kimi_cli.subagents.runner import run_soul_checked

        with (
            patch("kimi_cli.subagents.runner.run_soul") as mock_run_soul,
            patch("kimi_cli.subagents.runner.logger") as mock_logger,
        ):
            mock_run_soul.side_effect = MaxStepsReached(100)
            result = await run_soul_checked(
                soul=AsyncMock(),
                prompt="test",
                ui_loop_fn=AsyncMock(),
                wire_path=Path("/tmp/wire.jsonl"),
                phase="testing",
            )
            assert result is not None
            assert result.brief == "Max steps reached"
            mock_logger.warning.assert_called()

    async def test_api_status_error_logged(self):
        from kosong.chat_provider import APIStatusError

        from kimi_cli.subagents.runner import run_soul_checked

        with (
            patch("kimi_cli.subagents.runner.run_soul") as mock_run_soul,
            patch("kimi_cli.subagents.runner.logger") as mock_logger,
        ):
            mock_run_soul.side_effect = APIStatusError(429, "Rate limited")
            result = await run_soul_checked(
                soul=AsyncMock(),
                prompt="test",
                ui_loop_fn=AsyncMock(),
                wire_path=Path("/tmp/wire.jsonl"),
                phase="testing",
            )
            assert result is not None
            assert "429" in result.brief
            mock_logger.warning.assert_called()

    async def test_chat_provider_error_logged(self):
        from kosong.chat_provider import ChatProviderError

        from kimi_cli.subagents.runner import run_soul_checked

        with (
            patch("kimi_cli.subagents.runner.run_soul") as mock_run_soul,
            patch("kimi_cli.subagents.runner.logger") as mock_logger,
        ):
            mock_run_soul.side_effect = ChatProviderError("Provider down")
            result = await run_soul_checked(
                soul=AsyncMock(),
                prompt="test",
                ui_loop_fn=AsyncMock(),
                wire_path=Path("/tmp/wire.jsonl"),
                phase="testing",
            )
            assert result is not None
            assert result.brief == "LLM provider error"
            mock_logger.warning.assert_called()

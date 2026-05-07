"""Tests for UserPromptSubmit hook text extraction."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from kosong.message import ContentPart, TextPart

from kimi_cli.hooks.engine import HookEngine
from kimi_cli.soul.kimisoul import KimiSoul


def _make_runnable_soul() -> KimiSoul:
    """Minimal KimiSoul bypassing __init__, just enough for run()."""
    soul = object.__new__(KimiSoul)

    runtime = MagicMock()
    runtime.session.id = "test-session"
    runtime.approval_runtime = None
    runtime.oauth.ensure_fresh = AsyncMock()
    soul._runtime = runtime

    ctx = MagicMock()
    ctx.history = []
    ctx.append_message = AsyncMock()
    soul._context = ctx

    soul._hook_engine = MagicMock(spec=HookEngine)
    soul._hook_engine.trigger = AsyncMock(return_value=[])

    soul._loop_control = MagicMock()
    soul._loop_control.max_ralph_iterations = 0

    soul._agent = MagicMock()
    soul._agent.system_prompt = "sys"

    soul._turn = AsyncMock(return_value=MagicMock())
    soul._slash_commands = []
    soul._steer_queue = MagicMock()
    soul._steer_queue.empty.return_value = True

    soul._stop_hook_active = False
    soul._injection_providers = []
    soul._compaction = MagicMock()
    soul._checkpoint = AsyncMock()

    return soul


@pytest.mark.asyncio
async def test_user_prompt_submit_hook_receives_text_from_string() -> None:
    """When user_input is a plain string, the hook receives it as prompt."""
    soul = _make_runnable_soul()

    with patch("kimi_cli.soul.kimisoul.wire_send"):
        await soul.run("hello world")

    call_args = soul._hook_engine.trigger.call_args_list[0]
    assert call_args[0][0] == "UserPromptSubmit"
    assert call_args[1]["matcher_value"] == "hello world"
    assert call_args[1]["input_data"]["prompt"] == "hello world"


@pytest.mark.asyncio
async def test_user_prompt_submit_hook_receives_text_from_content_parts() -> None:
    """When user_input is a list of ContentPart, the hook receives extracted text."""
    soul = _make_runnable_soul()
    parts: list[ContentPart] = [TextPart(text="hello"), TextPart(text="world")]

    with patch("kimi_cli.soul.kimisoul.wire_send"):
        await soul.run(parts)

    call_args = soul._hook_engine.trigger.call_args_list[0]
    assert call_args[0][0] == "UserPromptSubmit"
    assert call_args[1]["matcher_value"] == "hello world"
    assert call_args[1]["input_data"]["prompt"] == "hello world"

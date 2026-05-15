"""Tests for KimiSoul lifecycle hook integration."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

import kimi_cli.soul.kimisoul as kimisoul_module
from kosong.tooling.empty import EmptyToolset

from kimi_cli.hooks.config import HookDef
from kimi_cli.hooks.engine import HookEngine
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.types import TextPart


@pytest.mark.asyncio
async def test_user_prompt_submit_extracts_text_from_content_parts(
    runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """UserPromptSubmit hook receives extracted text when input is list[ContentPart]."""
    captured_payloads: list[dict] = []

    async def _capture_trigger(event: str, *, matcher_value: str = "", input_data: dict | None = None) -> list:
        captured_payloads.append(input_data or {})
        return []

    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    soul._turn = AsyncMock(return_value=None)  # type: ignore[method-assign]
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    hook_engine = HookEngine([HookDef(event="UserPromptSubmit", command="echo ok", timeout=5)])
    monkeypatch.setattr(hook_engine, "trigger", _capture_trigger)
    soul.set_hook_engine(hook_engine)

    await soul.run([TextPart(text="hello world")])

    user_prompt_payloads = [p for p in captured_payloads if p.get("hook_event_name") == "UserPromptSubmit"]
    assert len(user_prompt_payloads) == 1
    assert user_prompt_payloads[0].get("prompt") == "hello world"

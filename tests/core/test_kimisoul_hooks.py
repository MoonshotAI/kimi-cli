"""Tests for KimiSoul lifecycle hook integration."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from kosong.message import Message
from kosong.tooling.empty import EmptyToolset

import kimi_cli.soul.kimisoul as kimisoul_module
from kimi_cli.hooks.config import HookDef
from kimi_cli.hooks.engine import HookEngine
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul, TurnOutcome
from kimi_cli.wire.types import TextPart


@pytest.mark.asyncio
async def test_stop_hook_includes_response_and_stop_reason(
    runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stop hook receives response text and stop_reason from TurnOutcome."""
    captured_payloads: list[dict] = []

    async def _capture_trigger(
        event: str, *, matcher_value: str = "", input_data: dict | None = None
    ) -> list:
        captured_payloads.append(input_data or {})
        return []

    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    soul = KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))
    soul._turn = AsyncMock(  # type: ignore[method-assign]
        return_value=TurnOutcome(
            stop_reason="no_tool_calls",
            final_message=Message(
                role="assistant", content=[TextPart(text="The fix is complete.")]
            ),
            step_count=1,
        )
    )
    monkeypatch.setattr(kimisoul_module, "wire_send", lambda _msg: None)

    hook_engine = HookEngine([HookDef(event="Stop", command="echo ok", timeout=5)])
    monkeypatch.setattr(hook_engine, "trigger", _capture_trigger)
    soul.set_hook_engine(hook_engine)

    await soul.run([TextPart(text="fix the bug")])

    stop_payloads = [p for p in captured_payloads if p.get("hook_event_name") == "Stop"]
    assert len(stop_payloads) == 1
    assert stop_payloads[0].get("response") == "The fix is complete."
    assert stop_payloads[0].get("stop_reason") == "no_tool_calls"

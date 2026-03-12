from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from kosong.message import ContentPart
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.jsonrpc import (
    ErrorCodes,
    JSONRPCErrorResponse,
    JSONRPCSteerMessage,
    JSONRPCSuccessResponse,
    Statuses,
)
from kimi_cli.wire.server import WireServer
from kimi_cli.wire.types import TextPart


def _make_soul(runtime: Runtime, tmp_path: Path) -> KimiSoul:
    agent = Agent(
        name="Steer Test Agent",
        system_prompt="Test prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return KimiSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


@pytest.mark.asyncio
async def test_handle_steer_returns_invalid_state_when_not_streaming(
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    server = WireServer(soul)

    response = await server._handle_steer(
        JSONRPCSteerMessage(
            id="1",
            params=JSONRPCSteerMessage.Params(user_input=[TextPart(text="follow-up")]),
        )
    )

    assert isinstance(response, JSONRPCErrorResponse)
    assert response.error.code == ErrorCodes.INVALID_STATE


@pytest.mark.asyncio
async def test_handle_steer_queues_input_when_streaming(
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soul = _make_soul(runtime, tmp_path)
    server = WireServer(soul)
    queued: list[str | list[ContentPart]] = []

    monkeypatch.setattr(soul, "steer", lambda user_input: queued.append(user_input))
    server._cancel_event = asyncio.Event()

    response = await server._handle_steer(
        JSONRPCSteerMessage(
            id="1",
            params=JSONRPCSteerMessage.Params(user_input=[TextPart(text="follow-up")]),
        )
    )

    assert isinstance(response, JSONRPCSuccessResponse)
    assert response.result == {"status": Statuses.STEERED}
    assert queued == [[TextPart(text="follow-up")]]

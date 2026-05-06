from __future__ import annotations

import asyncio
import contextlib
import json
from pathlib import Path

import pytest
from kosong.tooling.empty import EmptyToolset

from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.wire.ipc_server import IpcWireServer


@pytest.mark.asyncio
async def test_ipc_server_accepts_initialize(runtime: Runtime, tmp_path: Path) -> None:
    context = Context(file_backend=tmp_path / "history.jsonl")
    await context.write_system_prompt("Base system prompt.")
    soul = KimiSoul(
        Agent(
            name="Wire IPC Test",
            system_prompt="Base system prompt.",
            toolset=EmptyToolset(),
            runtime=runtime,
        ),
        context=context,
    )
    socket_path = tmp_path / "kimi.sock"
    server = IpcWireServer(soul, socket_path=str(socket_path))

    server_task = asyncio.create_task(server.serve())
    try:
        for _ in range(100):
            if socket_path.exists():
                break
            await asyncio.sleep(0.01)
        assert socket_path.exists()

        reader, writer = await asyncio.open_unix_connection(str(socket_path))
        writer.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": "init",
                    "method": "initialize",
                    "params": {
                        "protocol_version": "1.9",
                        "capabilities": {
                            "supports_question": True,
                            "supports_plan_mode": True,
                        },
                    },
                }
            ).encode()
            + b"\n"
        )
        await writer.drain()

        raw_response = await asyncio.wait_for(reader.readline(), timeout=2)
        response = json.loads(raw_response)

        assert response["id"] == "init"
        assert response["result"]["protocol_version"] == "1.9"
        assert response["result"]["session"]["id"] == runtime.session.id

        writer.close()
        await writer.wait_closed()
    finally:
        server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await server_task

    assert not socket_path.exists()

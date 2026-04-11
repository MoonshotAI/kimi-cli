from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from kimi_cli.acp.server import ACPServer

pytestmark = pytest.mark.asyncio


def _fake_config() -> SimpleNamespace:
    return SimpleNamespace(
        default_model="scripted",
        default_thinking=False,
        models={},
    )


def _fake_cli_instance() -> SimpleNamespace:
    return SimpleNamespace(
        soul=SimpleNamespace(
            runtime=SimpleNamespace(config=_fake_config()),
            agent=SimpleNamespace(toolset=object()),
        )
    )


@pytest.fixture
def acp_server(monkeypatch: pytest.MonkeyPatch) -> ACPServer:
    server = ACPServer()
    server.conn = SimpleNamespace(session_update=AsyncMock())
    server.client_capabilities = object()
    monkeypatch.setattr(server, "_check_auth", lambda: None)
    monkeypatch.setattr("kimi_cli.acp.server.ACPKaos", lambda *args, **kwargs: None)
    monkeypatch.setattr("kimi_cli.acp.server.soul_slash_registry.list_commands", lambda: [])
    return server


async def test_new_session_disables_user_feedback(
    acp_server: ACPServer,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    session = SimpleNamespace(id="s1")
    create_cli = AsyncMock(return_value=_fake_cli_instance())

    monkeypatch.setattr("kimi_cli.acp.server.Session.create", AsyncMock(return_value=session))
    monkeypatch.setattr("kimi_cli.acp.server.KimiCLI.create", create_cli)

    work_dir = tmp_path / "workdir"
    work_dir.mkdir()
    await acp_server.new_session(cwd=str(work_dir))

    assert create_cli.await_args.kwargs["can_request_user_feedback"] is False


async def test_setup_session_disables_user_feedback(
    acp_server: ACPServer,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    session = SimpleNamespace(id="s2")
    create_cli = AsyncMock(return_value=_fake_cli_instance())

    monkeypatch.setattr("kimi_cli.acp.server.Session.find", AsyncMock(return_value=session))
    monkeypatch.setattr("kimi_cli.acp.server.KimiCLI.create", create_cli)

    work_dir = tmp_path / "workdir"
    work_dir.mkdir()
    await acp_server._setup_session(cwd=str(work_dir), session_id="s2")

    assert create_cli.await_args.kwargs["can_request_user_feedback"] is False

"""Protocol V1 consistency tests using the real ACP SDK client."""

from __future__ import annotations

import acp
import pytest

from kimi_cli.acp.version import CURRENT_VERSION

from .conftest import ACPTestClient

pytestmark = pytest.mark.asyncio


async def test_initialize_returns_negotiated_version(
    acp_client: tuple[acp.ClientSideConnection, ACPTestClient],
):
    """initialize(protocol_version=1) returns version 1 with expected fields."""
    conn, _ = acp_client
    resp = await conn.initialize(protocol_version=1)

    assert resp.protocol_version == 1
    assert resp.agent_capabilities is not None
    assert resp.agent_capabilities.prompt_capabilities is not None
    assert resp.agent_info is not None
    assert resp.agent_info.name == "Kimi Code CLI"


async def test_initialize_with_higher_version(
    acp_client: tuple[acp.ClientSideConnection, ACPTestClient],
):
    """initialize(protocol_version=99) returns the server's current max version."""
    conn, _ = acp_client
    resp = await conn.initialize(protocol_version=99)

    assert resp.protocol_version == CURRENT_VERSION.protocol_version


async def test_new_session_response_shape(
    acp_client: tuple[acp.ClientSideConnection, ACPTestClient],
    tmp_path,
):
    """new_session returns session_id, modes, and models."""
    conn, _ = acp_client
    await conn.initialize(protocol_version=1)

    work_dir = tmp_path / "workdir"
    work_dir.mkdir(exist_ok=True)
    resp = await conn.new_session(cwd=str(work_dir))

    assert isinstance(resp.session_id, str)
    assert len(resp.session_id) > 0
    assert resp.modes is not None
    assert resp.models is not None


async def test_prompt_with_scripted_echo(
    acp_client: tuple[acp.ClientSideConnection, ACPTestClient],
    tmp_path,
):
    """Full flow: initialize → new_session → prompt returns a valid response."""
    conn, test_client = acp_client
    await conn.initialize(protocol_version=1)

    work_dir = tmp_path / "workdir"
    work_dir.mkdir(exist_ok=True)
    session_resp = await conn.new_session(cwd=str(work_dir))

    resp = await conn.prompt(
        prompt=[acp.text_block("Say hello")],
        session_id=session_resp.session_id,
    )

    assert resp.stop_reason in ("end_turn", "max_tokens", "max_turn_requests")
    # The scripted echo provider should have sent session updates
    assert len(test_client.updates) > 0


async def test_list_sessions(
    acp_client: tuple[acp.ClientSideConnection, ACPTestClient],
    tmp_path,
):
    """After creating a session and prompting, list_sessions returns it."""
    conn, _ = acp_client
    await conn.initialize(protocol_version=1)

    work_dir = tmp_path / "workdir"
    work_dir.mkdir(exist_ok=True)
    session_resp = await conn.new_session(cwd=str(work_dir))

    # Must prompt first; Session.list() skips empty sessions
    await conn.prompt(
        prompt=[acp.text_block("Hello")],
        session_id=session_resp.session_id,
    )

    list_resp = await conn.list_sessions(cwd=str(work_dir))
    session_ids = [s.session_id for s in list_resp.sessions]
    assert session_resp.session_id in session_ids


async def test_resume_session(
    acp_client: tuple[acp.ClientSideConnection, ACPTestClient],
    tmp_path,
):
    """initialize → new_session → prompt → resume_session returns modes and models."""
    conn, _ = acp_client
    await conn.initialize(protocol_version=1)

    work_dir = tmp_path / "workdir"
    work_dir.mkdir(exist_ok=True)
    session_resp = await conn.new_session(cwd=str(work_dir))

    # Must prompt first so the session is persisted
    await conn.prompt(
        prompt=[acp.text_block("Hello")],
        session_id=session_resp.session_id,
    )

    resume_resp = await conn.resume_session(
        cwd=str(work_dir),
        session_id=session_resp.session_id,
    )

    assert resume_resp.modes is not None
    assert resume_resp.modes.current_mode_id == "default"
    assert len(resume_resp.modes.available_modes) > 0
    assert resume_resp.models is not None
    assert isinstance(resume_resp.models.current_model_id, str)
    assert len(resume_resp.models.available_models) > 0


async def test_resume_session_not_found(
    acp_client: tuple[acp.ClientSideConnection, ACPTestClient],
    tmp_path,
):
    """resume_session with a non-existent session_id raises an error."""
    conn, _ = acp_client
    await conn.initialize(protocol_version=1)

    work_dir = tmp_path / "workdir"
    work_dir.mkdir(exist_ok=True)

    with pytest.raises(acp.RequestError):
        await conn.resume_session(
            cwd=str(work_dir),
            session_id="non-existent-session-id",
        )


async def test_cancel_session(
    acp_client: tuple[acp.ClientSideConnection, ACPTestClient],
    tmp_path,
):
    """cancel on an idle session completes without error."""
    conn, _ = acp_client
    await conn.initialize(protocol_version=1)

    work_dir = tmp_path / "workdir"
    work_dir.mkdir(exist_ok=True)
    session_resp = await conn.new_session(cwd=str(work_dir))

    # cancel should not raise
    await conn.cancel(session_id=session_resp.session_id)

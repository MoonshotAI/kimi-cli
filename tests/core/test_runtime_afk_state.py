"""Tests for Runtime approval state restoration."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

import kimi_cli.soul.agent as agent_module
from kimi_cli.auth.oauth import OAuthManager
from kimi_cli.soul.agent import Runtime


@pytest.fixture
def lightweight_runtime_create(monkeypatch: pytest.MonkeyPatch, environment) -> None:
    monkeypatch.setattr(agent_module, "list_directory", AsyncMock(return_value=""))
    monkeypatch.setattr(agent_module, "load_agents_md", AsyncMock(return_value=None))
    monkeypatch.setattr(agent_module.Environment, "detect", AsyncMock(return_value=environment))
    monkeypatch.setattr(agent_module, "resolve_skills_roots", AsyncMock(return_value=[]))
    monkeypatch.setattr(agent_module, "discover_skills_from_roots", AsyncMock(return_value=[]))
    monkeypatch.setattr(agent_module, "index_skills", lambda _skills: {})
    monkeypatch.setattr(agent_module, "format_skills_for_prompt", lambda _skills: None)


@pytest.mark.asyncio
async def test_runtime_create_restores_persisted_afk(
    config,
    session,
    lightweight_runtime_create,
) -> None:
    session.state.approval.afk = True

    runtime = await Runtime.create(
        config,
        OAuthManager(config),
        llm=None,
        session=session,
        yolo=False,
    )

    assert runtime.approval.is_afk() is True
    assert runtime.approval.is_afk_flag() is True


@pytest.mark.asyncio
async def test_explicit_afk_persists_to_session_state(
    config,
    session,
    lightweight_runtime_create,
) -> None:
    runtime = await Runtime.create(
        config,
        OAuthManager(config),
        llm=None,
        session=session,
        yolo=False,
        afk=True,
    )

    assert runtime.approval.is_afk() is True
    assert runtime.approval.is_afk_flag() is True
    assert session.state.approval.afk is True


@pytest.mark.asyncio
async def test_runtime_afk_overlay_does_not_persist_to_session_state(
    config,
    session,
    lightweight_runtime_create,
) -> None:
    runtime = await Runtime.create(
        config,
        OAuthManager(config),
        llm=None,
        session=session,
        yolo=False,
        runtime_afk=True,
    )

    assert runtime.approval.is_afk() is True
    assert runtime.approval.is_afk_flag() is False

    runtime.approval.set_yolo(True)

    assert session.state.approval.yolo is True
    assert session.state.approval.afk is False


@pytest.mark.asyncio
async def test_runtime_set_afk_persists_to_session_state(
    config,
    session,
    lightweight_runtime_create,
) -> None:
    runtime = await Runtime.create(
        config,
        OAuthManager(config),
        llm=None,
        session=session,
        yolo=False,
    )

    runtime.approval.set_afk(True)

    assert runtime.approval.is_afk() is True
    assert session.state.approval.afk is True

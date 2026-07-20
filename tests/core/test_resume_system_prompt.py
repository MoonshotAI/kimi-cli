"""Tests for system prompt refresh on session resume (#2420).

Resuming a session must not let a frozen, stale system prompt override the
freshly generated one — otherwise skills added to ``~/.kimi/skills``,
``AGENTS.md`` edits, and prompt-affecting config changes never take effect.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import kimi_cli.app as app_module
from kimi_cli.app import KimiCLI


class _FakeSoul:
    def __init__(self, agent, context):
        self.agent = agent
        self.plan_mode = False

    async def set_plan_mode_from_manual(self, enabled: bool) -> bool:
        return enabled

    def schedule_plan_activation_reminder(self) -> None:
        pass

    def set_hook_engine(self, engine) -> None:
        pass


def _patch_create_deps(monkeypatch, *, frozen_prompt: str | None, fresh_prompt: str):
    """Patch heavy KimiCLI.create() dependencies; return the fake context."""
    fake_context = SimpleNamespace(system_prompt=frozen_prompt)
    fake_context.restore = AsyncMock()

    async def write_system_prompt(prompt: str) -> None:
        fake_context.system_prompt = prompt

    fake_context.write_system_prompt = AsyncMock(side_effect=write_system_prompt)

    async def fake_runtime_create(config, _oauth, _llm, session, yolo, **kwargs):
        return SimpleNamespace(
            session=session,
            config=config,
            llm=None,
            approval=SimpleNamespace(is_yolo=lambda: yolo, is_afk=lambda: False),
            notifications=SimpleNamespace(recover=lambda: None),
            background_tasks=SimpleNamespace(reconcile=lambda: None),
        )

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda p, m: {})
    monkeypatch.setattr(app_module, "create_llm", lambda *a, **kw: None)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(
        app_module,
        "load_agent",
        AsyncMock(return_value=SimpleNamespace(name="test", system_prompt=fresh_prompt)),
    )
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)
    monkeypatch.setattr(app_module, "KimiSoul", _FakeSoul)
    return fake_context


@pytest.mark.asyncio
async def test_resume_refreshes_stale_system_prompt(session, config, monkeypatch):
    """A frozen prompt differing from the fresh one is replaced and persisted."""
    fake_context = _patch_create_deps(
        monkeypatch, frozen_prompt="old prompt without new skill", fresh_prompt="fresh prompt"
    )

    await KimiCLI.create(session, config=config, resumed=True)

    fake_context.write_system_prompt.assert_awaited_once_with("fresh prompt")
    assert fake_context.system_prompt == "fresh prompt"


@pytest.mark.asyncio
async def test_resume_keeps_prompt_when_unchanged(session, config, monkeypatch):
    """An up-to-date frozen prompt is left alone (no rewrite)."""
    fake_context = _patch_create_deps(
        monkeypatch, frozen_prompt="same prompt", fresh_prompt="same prompt"
    )

    await KimiCLI.create(session, config=config, resumed=True)

    fake_context.write_system_prompt.assert_not_awaited()


@pytest.mark.asyncio
async def test_new_session_writes_system_prompt(session, config, monkeypatch):
    """A session without a frozen prompt gets the fresh one written."""
    fake_context = _patch_create_deps(monkeypatch, frozen_prompt=None, fresh_prompt="fresh prompt")

    await KimiCLI.create(session, config=config, resumed=False)

    fake_context.write_system_prompt.assert_awaited_once_with("fresh prompt")

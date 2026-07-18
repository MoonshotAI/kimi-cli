"""Tests for thinking / thinking-effort resolution in KimiCLI.create().

Precedence rules under test:
- An explicit --thinking-effort flag implies the thinking switch (a level above
  "off" enables thinking, "off" disables it).
- An explicit --thinking flag beats --thinking-effort.
- Config-file effort levels (per-model > global) apply only when thinking is
  already on — they never flip the thinking switch by themselves.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import SecretStr

import kimi_cli.app as app_module
from kimi_cli.app import KimiCLI
from kimi_cli.config import Config, LLMModel, LLMProvider

_PROVIDER = "test-provider"
_MODEL = "test/model"


def _make_config(
    *,
    default_thinking: bool = False,
    default_effort: str | None = None,
    model_effort: str | None = None,
) -> Config:
    return Config(
        default_model=_MODEL,
        default_thinking=default_thinking,
        default_thinking_effort=default_effort,  # type: ignore[arg-type]
        providers={
            _PROVIDER: LLMProvider(
                type="kimi",
                base_url="https://api.test/v1",
                api_key=SecretStr("test-key"),
            )
        },
        models={
            _MODEL: LLMModel(
                provider=_PROVIDER,
                model="test-model",
                max_context_size=100_000,
                capabilities={"thinking"},
                thinking_effort=model_effort,  # type: ignore[arg-type]
            )
        },
    )


@pytest.fixture
def create_llm_calls(monkeypatch) -> list[dict]:
    """Patch heavy KimiCLI.create() dependencies and capture create_llm kwargs."""
    calls: list[dict] = []

    def fake_create_llm(*args, **kwargs):
        calls.append(kwargs)
        return None

    fake_context = SimpleNamespace(system_prompt=None)
    fake_context.restore = AsyncMock()
    fake_context.write_system_prompt = AsyncMock()

    async def fake_runtime_create(config, _oauth, _llm, session, yolo, **kwargs):
        return SimpleNamespace(
            session=session,
            config=config,
            llm=None,
            approval=SimpleNamespace(
                is_yolo=lambda: yolo,
                is_afk=lambda: kwargs.get("afk", False) or kwargs.get("runtime_afk", False),
            ),
            notifications=SimpleNamespace(recover=lambda: None),
            background_tasks=SimpleNamespace(reconcile=lambda: None),
        )

    class FakeSoul:
        def __init__(self, agent, context):
            pass

        def set_hook_engine(self, engine):
            pass

    monkeypatch.setattr(app_module, "load_config", lambda conf: conf)
    monkeypatch.setattr(app_module, "augment_provider_with_env_vars", lambda p, m: {})
    monkeypatch.setattr(app_module, "create_llm", fake_create_llm)
    monkeypatch.setattr(app_module.Runtime, "create", fake_runtime_create)
    monkeypatch.setattr(
        app_module,
        "load_agent",
        AsyncMock(return_value=SimpleNamespace(name="test", system_prompt="sp")),
    )
    monkeypatch.setattr(app_module, "Context", lambda _path: fake_context)
    monkeypatch.setattr(app_module, "KimiSoul", FakeSoul)
    return calls


class TestEffortFlagImpliesThinking:
    async def test_flag_level_enables_thinking_when_config_off(self, session, create_llm_calls):
        """--thinking-effort low with default_thinking=false still runs with thinking."""
        config = _make_config(default_thinking=False)

        await KimiCLI.create(session, config=config, thinking_effort="low", resumed=False)

        assert create_llm_calls[0]["thinking"] is True
        assert create_llm_calls[0]["thinking_effort"] == "low"

    async def test_flag_off_disables_thinking_when_config_on(self, session, create_llm_calls):
        """--thinking-effort off with default_thinking=true runs with thinking off."""
        config = _make_config(default_thinking=True)

        await KimiCLI.create(session, config=config, thinking_effort="off", resumed=False)

        assert create_llm_calls[0]["thinking"] is False
        assert create_llm_calls[0]["thinking_effort"] == "off"

    async def test_explicit_thinking_flag_beats_effort_flag(self, session, create_llm_calls):
        """--thinking wins over --thinking-effort off (explicit switch over level)."""
        config = _make_config(default_thinking=False)

        await KimiCLI.create(
            session, config=config, thinking=True, thinking_effort="off", resumed=False
        )

        assert create_llm_calls[0]["thinking"] is True
        assert create_llm_calls[0]["thinking_effort"] == "off"


class TestConfigEffortNeverFlipsSwitch:
    async def test_model_effort_does_not_enable_thinking(self, session, create_llm_calls):
        """Per-model config effort applies the level but leaves the switch as configured."""
        config = _make_config(default_thinking=False, model_effort="max")

        await KimiCLI.create(session, config=config, resumed=False)

        assert create_llm_calls[0]["thinking"] is False
        assert create_llm_calls[0]["thinking_effort"] == "max"

    async def test_global_effort_does_not_enable_thinking(self, session, create_llm_calls):
        """Global config effort applies the level but leaves the switch as configured."""
        config = _make_config(default_thinking=False, default_effort="low")

        await KimiCLI.create(session, config=config, resumed=False)

        assert create_llm_calls[0]["thinking"] is False
        assert create_llm_calls[0]["thinking_effort"] == "low"

    async def test_model_effort_applies_when_thinking_on(self, session, create_llm_calls):
        config = _make_config(default_thinking=True, model_effort="max")

        await KimiCLI.create(session, config=config, resumed=False)

        assert create_llm_calls[0]["thinking"] is True
        assert create_llm_calls[0]["thinking_effort"] == "max"


class TestEffortPrecedence:
    async def test_flag_beats_model_config(self, session, create_llm_calls):
        config = _make_config(default_thinking=True, model_effort="max")

        await KimiCLI.create(session, config=config, thinking_effort="low", resumed=False)

        assert create_llm_calls[0]["thinking_effort"] == "low"

    async def test_model_config_beats_global_config(self, session, create_llm_calls):
        config = _make_config(default_thinking=True, default_effort="low", model_effort="max")

        await KimiCLI.create(session, config=config, resumed=False)

        assert create_llm_calls[0]["thinking_effort"] == "max"

    async def test_no_effort_anywhere_passes_none(self, session, create_llm_calls):
        config = _make_config(default_thinking=True)

        await KimiCLI.create(session, config=config, resumed=False)

        assert create_llm_calls[0]["thinking"] is True
        assert create_llm_calls[0]["thinking_effort"] is None

"""Tests for the /effort slash command.

Verifies registration, the direct-args path (/effort <level>), per-model vs
global config persistence, invalid input handling, and the Reload flow.
"""

from __future__ import annotations

from collections.abc import Awaitable
from typing import Any
from unittest.mock import Mock

import pytest
from pydantic import SecretStr

from kimi_cli.cli import Reload
from kimi_cli.config import Config, LLMModel, LLMProvider
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell import slash as slash_module
from kimi_cli.ui.shell.slash import ShellSlashCmdFunc, shell_mode_registry
from kimi_cli.ui.shell.slash import registry as shell_slash_registry
from kimi_cli.utils.slashcmd import SlashCommand

_MODEL_NAME = "test/model"


def _make_config() -> Config:
    config = Config(
        default_model=_MODEL_NAME,
        default_thinking=True,
        providers={
            "test-provider": LLMProvider(
                type="kimi",
                base_url="https://api.test/v1",
                api_key=SecretStr("test-key"),
            )
        },
        models={
            _MODEL_NAME: LLMModel(
                provider="test-provider",
                model="test-model",
                max_context_size=100_000,
            )
        },
    )
    config.is_from_default_location = True
    return config


def _mock_shell(config: Config, effort: str | None = "high", session_id: str = "sess-1") -> Mock:
    """Mock Shell whose soul passes the KimiSoul isinstance check."""
    soul = Mock(spec=KimiSoul)
    soul.runtime.config = config
    soul.runtime.session.id = session_id
    soul.runtime.llm.model_config = config.models[_MODEL_NAME]
    soul.runtime.llm.chat_provider.thinking_effort = effort
    shell = Mock()
    shell.soul = soul
    return shell


async def _invoke(command: SlashCommand[ShellSlashCmdFunc], shell: Any, args: str) -> None:
    ret = command.func(shell, args)
    if isinstance(ret, Awaitable):
        await ret


@pytest.fixture
def harness(monkeypatch):
    """Wire load/save config to an in-memory Config."""
    config = _make_config()
    saved: list[Config] = []

    monkeypatch.setattr(slash_module, "load_config", lambda: config)
    monkeypatch.setattr(slash_module, "save_config", lambda cfg: saved.append(cfg))

    shell = _mock_shell(config)
    cmd = shell_slash_registry.find_command("effort")
    assert cmd is not None
    return shell, config, saved, cmd


class TestEffortCommandRegistration:
    def test_registered_in_shell_registry(self) -> None:
        cmd = shell_slash_registry.find_command("effort")
        assert cmd is not None
        assert cmd.name == "effort"
        assert "effort" in cmd.description

    def test_not_in_shell_mode_registry(self) -> None:
        assert shell_mode_registry.find_command("effort") is None


class TestEffortCommandArgs:
    async def test_set_level_saves_per_model_and_reloads(self, harness) -> None:
        shell, config, saved, cmd = harness

        with pytest.raises(Reload) as exc_info:
            await _invoke(cmd, shell, "max")

        assert exc_info.value.session_id == "sess-1"
        assert len(saved) == 1
        assert saved[0].models[_MODEL_NAME].thinking_effort == "max"
        # thinking was already on — stays on
        assert saved[0].default_thinking is True
        # in-memory config stays in sync for this process
        assert config.models[_MODEL_NAME].thinking_effort == "max"

    async def test_set_level_enables_thinking_when_off(self, harness) -> None:
        """Picking a level while thinking is off also flips default_thinking on,
        so the level actually takes effect after the reload."""
        shell, config, saved, cmd = harness
        config.default_thinking = False

        with pytest.raises(Reload):
            await _invoke(cmd, shell, "low")

        assert saved[0].models[_MODEL_NAME].thinking_effort == "low"
        assert saved[0].default_thinking is True
        assert config.default_thinking is True

    async def test_off_switches_thinking_off(self, harness) -> None:
        """/effort off persists default_thinking=false so it survives the reload."""
        shell, config, saved, cmd = harness
        assert config.default_thinking is True

        with pytest.raises(Reload):
            await _invoke(cmd, shell, "off")

        assert saved[0].models[_MODEL_NAME].thinking_effort == "off"
        assert saved[0].default_thinking is False
        assert config.default_thinking is False

    async def test_off_rejected_for_always_thinking_model(self, harness) -> None:
        """A model that always thinks cannot be turned off via /effort off."""
        shell, config, saved, cmd = harness
        config.models[_MODEL_NAME].model = "test-model-thinking"  # name implies always-thinking

        await _invoke(cmd, shell, "off")

        assert saved == []
        assert config.models[_MODEL_NAME].thinking_effort is None

    async def test_default_clears_override(self, harness) -> None:
        shell, config, saved, cmd = harness
        config.models[_MODEL_NAME].thinking_effort = "max"
        config.default_thinking = False

        with pytest.raises(Reload):
            await _invoke(cmd, shell, "default")

        assert len(saved) == 1
        assert saved[0].models[_MODEL_NAME].thinking_effort is None
        # clearing the level leaves the thinking switch untouched
        assert saved[0].default_thinking is False
        assert config.default_thinking is False

    async def test_invalid_level_is_rejected_without_save(self, harness) -> None:
        shell, config, saved, cmd = harness

        await _invoke(cmd, shell, "ultra")

        assert saved == []
        assert config.models[_MODEL_NAME].thinking_effort is None

    async def test_noop_when_level_already_set(self, harness) -> None:
        shell, config, saved, cmd = harness
        config.models[_MODEL_NAME].thinking_effort = "max"

        await _invoke(cmd, shell, "max")

        assert saved == []

    async def test_falls_back_to_global_default_when_model_unknown(
        self, harness, monkeypatch
    ) -> None:
        shell, config, saved, cmd = harness
        # runtime model does not match any configured model -> global default
        shell.soul.runtime.llm.model_config = LLMModel(
            provider="test-provider",
            model="some-other-model",
            max_context_size=8192,
        )

        with pytest.raises(Reload):
            await _invoke(cmd, shell, "low")

        assert len(saved) == 1
        assert saved[0].default_thinking_effort == "low"
        assert config.default_thinking_effort == "low"

    async def test_requires_default_config_location(self, harness) -> None:
        shell, config, saved, cmd = harness
        config.is_from_default_location = False

        await _invoke(cmd, shell, "max")

        assert saved == []

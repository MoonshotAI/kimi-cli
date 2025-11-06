"""Tests for thinking mode functionality in KimiSoul."""

from pathlib import Path

import pytest
from pydantic import SecretStr

from kimi_cli.config import LLMModel, LLMProvider
from kimi_cli.llm import create_llm
from kimi_cli.soul import LLMNotSet
from kimi_cli.soul.agent import Agent
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.runtime import Runtime
from kimi_cli.soul.toolset import CustomToolset


@pytest.fixture
def context(tmp_path: Path):
    """Create a Context instance for testing."""
    return Context(file_backend=tmp_path / "test_context.json")


def create_test_runtime(config, llm, session, builtin_args, denwa_renji, approval):
    """Helper to create a Runtime instance."""
    return Runtime(
        config=config,
        llm=llm,
        session=session,
        builtin_args=builtin_args,
        denwa_renji=denwa_renji,
        approval=approval,
    )


class TestDedicatedThinkingModels:
    """Test dedicated thinking model detection and behavior."""

    def test_kimi_k2_thinking_detection(
        self, config, session, builtin_args, denwa_renji, approval, context
    ):
        """Test that kimi-k2-thinking is detected as a dedicated thinking model."""
        provider = LLMProvider(
            type="kimi",
            base_url="https://api.moonshot.cn/v1",
            api_key=SecretStr("test-key"),
        )
        model = LLMModel(
            provider="kimi",
            model="kimi-k2-thinking",
            max_context_size=200000,
            capabilities={"thinking"},
        )
        llm = create_llm(provider, model)
        runtime = create_test_runtime(config, llm, session, builtin_args, denwa_renji, approval)

        agent = Agent(name="test-agent", system_prompt="Test prompt", toolset=CustomToolset([]))
        soul = KimiSoul(agent, runtime, context=context)

        assert soul.is_dedicated_thinking_model is True
        assert soul.supports_runtime_thinking_control is False

    def test_kimi_k2_thinking_turbo_detection(
        self, config, session, builtin_args, denwa_renji, approval, context
    ):
        """Test that kimi-k2-thinking-turbo is detected as a dedicated thinking model."""
        provider = LLMProvider(
            type="kimi",
            base_url="https://api.moonshot.cn/v1",
            api_key=SecretStr("test-key"),
        )
        model = LLMModel(
            provider="kimi",
            model="kimi-k2-thinking-turbo",
            max_context_size=200000,
            capabilities={"thinking"},
        )
        llm = create_llm(provider, model)
        runtime = create_test_runtime(config, llm, session, builtin_args, denwa_renji, approval)

        agent = Agent(name="test-agent", system_prompt="Test prompt", toolset=CustomToolset([]))
        soul = KimiSoul(agent, runtime, context=context)

        assert soul.is_dedicated_thinking_model is True
        assert soul.supports_runtime_thinking_control is False

    def test_regular_kimi_not_dedicated_thinking(
        self, config, session, builtin_args, denwa_renji, approval, context
    ):
        """Test that regular kimi models are not detected as dedicated thinking models."""
        provider = LLMProvider(
            type="kimi",
            base_url="https://api.moonshot.cn/v1",
            api_key=SecretStr("test-key"),
        )
        model = LLMModel(
            provider="kimi",
            model="kimi-auto",
            max_context_size=200000,
        )
        llm = create_llm(provider, model)
        runtime = create_test_runtime(config, llm, session, builtin_args, denwa_renji, approval)

        agent = Agent(name="test-agent", system_prompt="Test prompt", toolset=CustomToolset([]))
        soul = KimiSoul(agent, runtime, context=context)

        assert soul.is_dedicated_thinking_model is False
        assert soul.supports_runtime_thinking_control is True

    def test_dedicated_thinking_model_ignores_set_thinking_mode(
        self, config, session, builtin_args, denwa_renji, approval, context
    ):
        """Test that set_thinking_mode is ignored for dedicated thinking models."""
        provider = LLMProvider(
            type="kimi",
            base_url="https://api.moonshot.cn/v1",
            api_key=SecretStr("test-key"),
        )
        model = LLMModel(
            provider="kimi",
            model="kimi-k2-thinking",
            max_context_size=200000,
            capabilities={"thinking"},
        )
        llm = create_llm(provider, model)
        runtime = create_test_runtime(config, llm, session, builtin_args, denwa_renji, approval)

        agent = Agent(name="test-agent", system_prompt="Test prompt", toolset=CustomToolset([]))
        soul = KimiSoul(agent, runtime, context=context)

        soul.set_thinking_mode(False)
        soul.set_thinking_mode(True)


class TestRuntimeThinkingControl:
    """Test runtime thinking control for supported models."""

    def test_regular_kimi_supports_runtime_control(
        self, config, session, builtin_args, denwa_renji, approval, context
    ):
        """Test that regular kimi models support runtime thinking control."""
        provider = LLMProvider(
            type="kimi",
            base_url="https://api.moonshot.cn/v1",
            api_key=SecretStr("test-key"),
        )
        model = LLMModel(
            provider="kimi",
            model="kimi-auto",
            max_context_size=200000,
        )
        llm = create_llm(provider, model)
        runtime = create_test_runtime(config, llm, session, builtin_args, denwa_renji, approval)

        agent = Agent(name="test-agent", system_prompt="Test prompt", toolset=CustomToolset([]))
        soul = KimiSoul(agent, runtime, context=context)

        assert soul.is_dedicated_thinking_model is False
        assert soul.supports_runtime_thinking_control is True

    def test_non_kimi_provider_raises_not_implemented(
        self, config, session, builtin_args, denwa_renji, approval, context
    ):
        """Test that non-Kimi providers raise NotImplementedError for thinking mode."""
        provider = LLMProvider(
            type="openai_legacy",
            base_url="https://api.openai.com/v1",
            api_key=SecretStr("test-key"),
        )
        model = LLMModel(
            provider="openai",
            model="gpt-4o",
            max_context_size=128000,
        )
        llm = create_llm(provider, model)
        runtime = create_test_runtime(config, llm, session, builtin_args, denwa_renji, approval)

        agent = Agent(name="test-agent", system_prompt="Test prompt", toolset=CustomToolset([]))
        soul = KimiSoul(agent, runtime, context=context)

        with pytest.raises(
            NotImplementedError, match="does not support runtime thinking mode control"
        ):
            soul.set_thinking_mode(True)

        soul.set_thinking_mode(False)

    def test_llm_not_set_raises_error(
        self, context, config, session, builtin_args, denwa_renji, approval
    ):
        """Test that set_thinking_mode raises LLMNotSet when LLM is not configured."""
        runtime = create_test_runtime(
            config, None, session, builtin_args, denwa_renji, approval
        )

        agent = Agent(name="test-agent", system_prompt="Test prompt", toolset=CustomToolset([]))
        soul = KimiSoul(agent, runtime, context=context)

        with pytest.raises(LLMNotSet):
            soul.set_thinking_mode(True)


class TestThinkingModeUI:
    """Test thinking mode UI behavior."""

    def test_dedicated_thinking_model_ui_behavior(
        self, config, session, builtin_args, denwa_renji, approval, context
    ):
        """Test UI behavior for dedicated thinking models."""
        provider = LLMProvider(
            type="kimi",
            base_url="https://api.moonshot.cn/v1",
            api_key=SecretStr("test-key"),
        )
        model = LLMModel(
            provider="kimi",
            model="kimi-k2-thinking",
            max_context_size=200000,
            capabilities={"thinking"},
        )
        llm = create_llm(provider, model)
        runtime = create_test_runtime(config, llm, session, builtin_args, denwa_renji, approval)

        agent = Agent(name="test-agent", system_prompt="Test prompt", toolset=CustomToolset([]))
        soul = KimiSoul(agent, runtime, context=context)

        assert soul.is_dedicated_thinking_model is True
        assert soul.supports_runtime_thinking_control is False
        soul.set_thinking_mode(True)
        soul.set_thinking_mode(False)

    def test_regular_kimi_ui_behavior(
        self, config, session, builtin_args, denwa_renji, approval, context
    ):
        """Test UI behavior for regular Kimi models."""
        provider = LLMProvider(
            type="kimi",
            base_url="https://api.moonshot.cn/v1",
            api_key=SecretStr("test-key"),
        )
        model = LLMModel(
            provider="kimi",
            model="kimi-auto",
            max_context_size=200000,
        )
        llm = create_llm(provider, model)
        runtime = create_test_runtime(config, llm, session, builtin_args, denwa_renji, approval)

        agent = Agent(name="test-agent", system_prompt="Test prompt", toolset=CustomToolset([]))
        soul = KimiSoul(agent, runtime, context=context)

        assert soul.is_dedicated_thinking_model is False
        assert soul.supports_runtime_thinking_control is True
        soul.set_thinking_mode(True)
        soul.set_thinking_mode(False)

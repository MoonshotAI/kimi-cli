from __future__ import annotations

from inline_snapshot import snapshot
from kosong.chat_provider.echo import EchoChatProvider
from kosong.chat_provider.kimi import Kimi
from kosong.contrib.chat_provider.openai_responses import OpenAIResponses
from pydantic import SecretStr

from kimi_cli.config import LLMModel, LLMProvider
from kimi_cli.llm import augment_provider_with_env_vars, create_llm


def test_augment_provider_with_env_vars_kimi(monkeypatch):
    provider = LLMProvider(
        type="kimi",
        base_url="https://original.test/v1",
        api_key=SecretStr("orig-key"),
    )
    model = LLMModel(
        provider="kimi",
        model="kimi-base",
        max_context_size=4096,
        capabilities=None,
    )

    monkeypatch.setenv("KIMI_BASE_URL", "https://env.test/v1")
    monkeypatch.setenv("KIMI_API_KEY", "env-key")
    monkeypatch.setenv("KIMI_MODEL_NAME", "kimi-env-model")
    monkeypatch.setenv("KIMI_MODEL_MAX_CONTEXT_SIZE", "8192")
    monkeypatch.setenv("KIMI_MODEL_CAPABILITIES", "Image_In,THINKING,unknown")

    augment_provider_with_env_vars(provider, model)

    assert provider == snapshot(
        LLMProvider(
            type="kimi",
            base_url="https://env.test/v1",
            api_key=SecretStr("env-key"),
        )
    )
    assert model == snapshot(
        LLMModel(
            provider="kimi",
            model="kimi-env-model",
            max_context_size=8192,
            capabilities={"image_in", "thinking"},
        )
    )


def test_create_llm_kimi_model_parameters(monkeypatch):
    provider = LLMProvider(
        type="kimi",
        base_url="https://api.test/v1",
        api_key=SecretStr("test-key"),
    )
    model = LLMModel(
        provider="kimi",
        model="kimi-base",
        max_context_size=4096,
        capabilities=None,
    )

    monkeypatch.setenv("KIMI_MODEL_TEMPERATURE", "0.2")
    monkeypatch.setenv("KIMI_MODEL_TOP_P", "0.8")
    monkeypatch.setenv("KIMI_MODEL_MAX_TOKENS", "1234")

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, Kimi)

    assert llm.chat_provider.model_parameters == snapshot(
        {
            "base_url": "https://api.test/v1/",
            "temperature": 0.2,
            "top_p": 0.8,
            "max_tokens": 1234,
        }
    )


def test_create_llm_echo_provider():
    provider = LLMProvider(type="_echo", base_url="", api_key=SecretStr(""))
    model = LLMModel(provider="_echo", model="echo", max_context_size=1234)

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, EchoChatProvider)
    assert llm.max_context_size == 1234


def test_create_llm_anthropic_with_session_id():
    from kosong.contrib.chat_provider.anthropic import Anthropic

    provider = LLMProvider(
        type="anthropic",
        base_url="https://api.anthropic.com",
        api_key=SecretStr("test-key"),
    )
    model = LLMModel(
        provider="anthropic",
        model="claude-sonnet-4-20250514",
        max_context_size=200000,
    )

    llm = create_llm(provider, model, session_id="sess-abc-123")
    assert llm is not None
    assert isinstance(llm.chat_provider, Anthropic)
    assert llm.chat_provider._metadata == snapshot({"user_id": "sess-abc-123"})


def test_create_llm_anthropic_without_session_id():
    from kosong.contrib.chat_provider.anthropic import Anthropic

    provider = LLMProvider(
        type="anthropic",
        base_url="https://api.anthropic.com",
        api_key=SecretStr("test-key"),
    )
    model = LLMModel(
        provider="anthropic",
        model="claude-sonnet-4-20250514",
        max_context_size=200000,
    )

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, Anthropic)
    assert llm.chat_provider._metadata is None


def test_create_llm_requires_base_url_for_kimi():
    provider = LLMProvider(type="kimi", base_url="", api_key=SecretStr("test-key"))
    model = LLMModel(provider="kimi", model="kimi-base", max_context_size=4096)

    assert create_llm(provider, model) is None


def test_create_llm_openai_responses_does_not_force_reasoning_off():
    provider = LLMProvider(
        type="openai_responses",
        base_url="https://openrouter.ai/api/v1",
        api_key=SecretStr("test-key"),
    )
    model = LLMModel(
        provider="openrouter_custom",
        model="minimax/minimax-m2.5",
        max_context_size=128000,
        capabilities=None,
    )

    llm = create_llm(provider, model, thinking=False)

    assert llm is not None
    assert isinstance(llm.chat_provider, OpenAIResponses)
    assert llm.chat_provider.model_parameters == snapshot(
        {
            "base_url": "https://openrouter.ai/api/v1/",
        }
    )

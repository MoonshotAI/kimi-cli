from __future__ import annotations

from inline_snapshot import snapshot
from kosong.chat_provider.echo import EchoChatProvider
from kosong.chat_provider.kimi import Kimi
from pydantic import SecretStr

from gitrekt_cli.config import LLMModel, LLMProvider
from gitrekt_cli.llm import augment_provider_with_env_vars, create_llm


def test_augment_provider_with_env_vars_gitrekt(monkeypatch):
    provider = LLMProvider(
        type="gitrekt",
        base_url="https://original.test/v1",
        api_key=SecretStr("orig-key"),
    )
    model = LLMModel(
        provider="gitrekt",
        model="gitrekt-base",
        max_context_size=4096,
        capabilities=None,
    )

    monkeypatch.setenv("GITREKT_BASE_URL", "https://env.test/v1")
    monkeypatch.setenv("GITREKT_API_KEY", "env-key")
    monkeypatch.setenv("GITREKT_MODEL_NAME", "gitrekt-env-model")
    monkeypatch.setenv("GITREKT_MODEL_MAX_CONTEXT_SIZE", "8192")
    monkeypatch.setenv("GITREKT_MODEL_CAPABILITIES", "Image_In,THINKING,unknown")

    augment_provider_with_env_vars(provider, model)

    assert provider == snapshot(
        LLMProvider(
            type="gitrekt",
            base_url="https://env.test/v1",
            api_key=SecretStr("env-key"),
        )
    )
    assert model == snapshot(
        LLMModel(
            provider="gitrekt",
            model="gitrekt-env-model",
            max_context_size=8192,
            capabilities={"image_in", "thinking"},
        )
    )


def test_create_llm_gitrekt_model_parameters(monkeypatch):
    provider = LLMProvider(
        type="gitrekt",
        base_url="https://api.test/v1",
        api_key=SecretStr("test-key"),
    )
    model = LLMModel(
        provider="gitrekt",
        model="gitrekt-base",
        max_context_size=4096,
        capabilities=None,
    )

    monkeypatch.setenv("GITREKT_MODEL_TEMPERATURE", "0.2")
    monkeypatch.setenv("GITREKT_MODEL_TOP_P", "0.8")
    monkeypatch.setenv("GITREKT_MODEL_MAX_TOKENS", "1234")

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, Kimi)

    # ChatProvider does not have model_parameters attribute, but Kimi does
    from kosong.chat_provider.kimi import Kimi as KimiProvider

    assert isinstance(llm.chat_provider, KimiProvider)
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


def test_create_llm_requires_base_url_for_gitrekt():
    provider = LLMProvider(type="gitrekt", base_url="", api_key=SecretStr("test-key"))
    model = LLMModel(provider="gitrekt", model="gitrekt-base", max_context_size=4096)

    assert create_llm(provider, model) is None

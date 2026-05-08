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


def test_create_llm_openai_legacy_custom_headers():
    from kosong.contrib.chat_provider.openai_legacy import OpenAILegacy

    provider = LLMProvider(
        type="openai_legacy",
        base_url="https://api.openai.com/v1",
        api_key=SecretStr("test-key"),
        custom_headers={"X-Custom": "value", "X-Canary": "always"},
    )
    model = LLMModel(
        provider="openai",
        model="gpt-4o",
        max_context_size=128000,
    )

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, OpenAILegacy)
    assert llm.chat_provider._client_kwargs.get("default_headers") == {
        "X-Custom": "value",
        "X-Canary": "always",
    }


def test_create_llm_openai_legacy_default_reasoning_key():
    from kosong.contrib.chat_provider.openai_legacy import OpenAILegacy

    provider = LLMProvider(
        type="openai_legacy",
        base_url="https://api.deepseek.com/v1",
        api_key=SecretStr("test-key"),
    )
    model = LLMModel(
        provider="openai_legacy",
        model="deepseek-reasoner",
        max_context_size=128000,
    )

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, OpenAILegacy)
    assert llm.chat_provider._reasoning_key == "reasoning_content"


def test_create_llm_openai_legacy_custom_reasoning_key():
    from kosong.contrib.chat_provider.openai_legacy import OpenAILegacy

    provider = LLMProvider(
        type="openai_legacy",
        base_url="https://example.test/v1",
        api_key=SecretStr("test-key"),
        reasoning_key="reasoning",
    )
    model = LLMModel(
        provider="openai_legacy",
        model="some-reasoner",
        max_context_size=128000,
    )

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, OpenAILegacy)
    assert llm.chat_provider._reasoning_key == "reasoning"


def test_create_llm_openai_legacy_disabled_reasoning_key():
    from kosong.contrib.chat_provider.openai_legacy import OpenAILegacy

    provider = LLMProvider(
        type="openai_legacy",
        base_url="https://example.test/v1",
        api_key=SecretStr("test-key"),
        reasoning_key="",
    )
    model = LLMModel(
        provider="openai_legacy",
        model="plain-model",
        max_context_size=128000,
    )

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, OpenAILegacy)
    assert llm.chat_provider._reasoning_key == ""


def test_create_llm_openai_responses_custom_headers():
    provider = LLMProvider(
        type="openai_responses",
        base_url="https://api.openai.com/v1",
        api_key=SecretStr("test-key"),
        custom_headers={"X-Custom": "value"},
    )
    model = LLMModel(
        provider="openai",
        model="gpt-4o",
        max_context_size=128000,
    )

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, OpenAIResponses)
    assert llm.chat_provider._client_kwargs.get("default_headers") == {"X-Custom": "value"}


def test_create_llm_anthropic_custom_headers():
    from kosong.contrib.chat_provider.anthropic import Anthropic

    provider = LLMProvider(
        type="anthropic",
        base_url="https://api.anthropic.com",
        api_key=SecretStr("test-key"),
        custom_headers={"X-Custom": "value"},
    )
    model = LLMModel(
        provider="anthropic",
        model="claude-sonnet-4-20250514",
        max_context_size=200000,
    )

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, Anthropic)
    # AsyncAnthropic stores custom headers in _custom_headers
    assert llm.chat_provider._client._custom_headers.get("X-Custom") == "value"


def test_create_llm_google_genai_custom_headers():
    from kosong.contrib.chat_provider.google_genai import GoogleGenAI

    provider = LLMProvider(
        type="google_genai",
        base_url="https://generativelanguage.googleapis.com",
        api_key=SecretStr("test-key"),
        custom_headers={"X-Custom": "value"},
    )
    model = LLMModel(
        provider="google_genai",
        model="gemini-2.5-pro",
        max_context_size=1000000,
    )

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, GoogleGenAI)
    # Google GenAI client stores http_options on _api_client
    http_options = llm.chat_provider._client._api_client._http_options
    assert http_options.headers is not None
    assert http_options.headers.get("X-Custom") == "value"


def test_create_llm_vertexai_custom_headers():
    from kosong.contrib.chat_provider.google_genai import GoogleGenAI

    provider = LLMProvider(
        type="vertexai",
        base_url="https://us-central1-aiplatform.googleapis.com",
        api_key=SecretStr("test-key"),
        custom_headers={"X-Custom": "value"},
    )
    model = LLMModel(
        provider="vertexai",
        model="gemini-2.5-pro",
        max_context_size=1000000,
    )

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, GoogleGenAI)
    http_options = llm.chat_provider._client._api_client._http_options
    assert http_options.headers is not None
    assert http_options.headers.get("X-Custom") == "value"


def test_create_llm_custom_headers_isolated_between_instances():
    """Mutating headers on one instance must not affect another created from the same provider."""
    from kosong.contrib.chat_provider.openai_legacy import OpenAILegacy

    provider = LLMProvider(
        type="openai_legacy",
        base_url="https://api.openai.com/v1",
        api_key=SecretStr("test-key"),
        custom_headers={"X-Custom": "original"},
    )
    model = LLMModel(
        provider="openai",
        model="gpt-4o",
        max_context_size=128000,
    )

    llm1 = create_llm(provider, model)
    llm2 = create_llm(provider, model)
    assert llm1 is not None and llm2 is not None
    assert isinstance(llm1.chat_provider, OpenAILegacy)
    assert isinstance(llm2.chat_provider, OpenAILegacy)

    # Mutate headers on the first instance
    llm1.chat_provider._client_kwargs["default_headers"]["X-Custom"] = "mutated"

    # Second instance must be unaffected
    assert llm2.chat_provider._client_kwargs["default_headers"]["X-Custom"] == "original"
    # Original provider must also be unaffected
    assert provider.custom_headers is not None
    assert provider.custom_headers["X-Custom"] == "original"


def test_create_llm_no_custom_headers_keeps_existing_behavior():
    """When custom_headers is None, providers should work exactly as before."""
    from kosong.contrib.chat_provider.openai_legacy import OpenAILegacy

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
    assert llm is not None
    assert isinstance(llm.chat_provider, OpenAILegacy)
    # When custom_headers is None, the SDK client should have no custom headers
    assert llm.chat_provider.client._custom_headers == {}


def test_create_llm_openai_responses_thinking_false_no_reasoning_in_params():
    """thinking=False should call with_thinking("off"), which sets reasoning_effort=None.
    The OpenAIResponses provider handles this by omitting reasoning from the request."""
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
    # with_thinking("off") sets reasoning_effort=None in generation kwargs,
    # but generate() will omit reasoning from the actual API request when effort is None.
    assert llm.chat_provider.model_parameters == snapshot(
        {
            "base_url": "https://openrouter.ai/api/v1/",
            "reasoning_effort": None,
        }
    )


def _make_kimi_thinking_model() -> tuple[LLMProvider, LLMModel]:
    """Helper: build a kimi provider + always-thinking model pair."""
    provider = LLMProvider(
        type="kimi",
        base_url="https://api.test/v1",
        api_key=SecretStr("test-key"),
    )
    model = LLMModel(
        provider="kimi",
        model="kimi-k2-thinking-turbo",
        max_context_size=4096,
        capabilities=None,
    )
    return provider, model


def _make_kimi_plain_model() -> tuple[LLMProvider, LLMModel]:
    """Helper: build a kimi provider + non-thinking model pair."""
    provider = LLMProvider(
        type="kimi",
        base_url="https://api.test/v1",
        api_key=SecretStr("test-key"),
    )
    model = LLMModel(
        provider="kimi",
        model="kimi-k2-turbo-preview",
        max_context_size=4096,
        capabilities=None,
    )
    return provider, model


def test_create_llm_kimi_thinking_keep_not_set_omits_field(monkeypatch):
    """When KIMI_MODEL_THINKING_KEEP is unset, extra_body.thinking must not
    contain a ``keep`` key, even for always-thinking models."""
    monkeypatch.delenv("KIMI_MODEL_THINKING_KEEP", raising=False)
    provider, model = _make_kimi_thinking_model()

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, Kimi)

    extra_body = llm.chat_provider.model_parameters.get("extra_body") or {}
    thinking = extra_body.get("thinking") or {}
    assert "keep" not in thinking
    assert thinking.get("type") == "enabled"


def test_create_llm_kimi_thinking_keep_empty_string_omits_field(monkeypatch):
    """An empty-string env value must be treated as unset (consistent with
    other KIMI_MODEL_* envs that use walrus-truthy reads)."""
    monkeypatch.setenv("KIMI_MODEL_THINKING_KEEP", "")
    provider, model = _make_kimi_thinking_model()

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, Kimi)

    extra_body = llm.chat_provider.model_parameters.get("extra_body") or {}
    thinking = extra_body.get("thinking") or {}
    assert "keep" not in thinking


def test_create_llm_kimi_thinking_keep_all_injects_field(monkeypatch):
    """With a thinking-capable model and KIMI_MODEL_THINKING_KEEP=all, the
    provider's extra_body.thinking must carry both ``type`` (set by
    with_thinking) and ``keep`` (set by the env)."""
    monkeypatch.setenv("KIMI_MODEL_THINKING_KEEP", "all")
    provider, model = _make_kimi_thinking_model()

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, Kimi)

    assert llm.chat_provider.model_parameters.get("extra_body") == snapshot(
        {"thinking": {"type": "enabled", "keep": "all"}}
    )


def test_create_llm_kimi_thinking_keep_arbitrary_value_passes_through(monkeypatch):
    """Non-'all' values must be forwarded unchanged — no casing normalization,
    no validation. The Moonshot API is the source of truth."""
    monkeypatch.setenv("KIMI_MODEL_THINKING_KEEP", "xYz")
    provider, model = _make_kimi_thinking_model()

    llm = create_llm(provider, model)
    assert llm is not None
    assert isinstance(llm.chat_provider, Kimi)

    extra_body = llm.chat_provider.model_parameters.get("extra_body") or {}
    assert extra_body.get("thinking", {}).get("keep") == "xYz"


def test_create_llm_kimi_thinking_keep_skipped_when_thinking_off(monkeypatch):
    """When thinking=False (with_thinking("off")), keep must NOT be injected,
    even if the env is set. Avoids sending a `thinking.keep` without an
    accompanying `thinking.type` that the API actually honors."""
    monkeypatch.setenv("KIMI_MODEL_THINKING_KEEP", "all")
    provider, model = _make_kimi_plain_model()
    # capabilities is None and model name has no "thinking"/"reason" marker, so
    # derive_model_capabilities returns an empty set. thinking=False then drives
    # with_thinking("off").
    llm = create_llm(provider, model, thinking=False)
    assert llm is not None
    assert isinstance(llm.chat_provider, Kimi)

    extra_body = llm.chat_provider.model_parameters.get("extra_body") or {}
    thinking = extra_body.get("thinking") or {}
    assert "keep" not in thinking


def test_create_llm_kimi_thinking_keep_skipped_when_no_thinking_branch(monkeypatch):
    """When the model has no thinking capability and thinking is None, neither
    with_thinking branch runs — keep must also NOT be injected."""
    monkeypatch.setenv("KIMI_MODEL_THINKING_KEEP", "all")
    provider, model = _make_kimi_plain_model()

    llm = create_llm(provider, model, thinking=None)
    assert llm is not None
    assert isinstance(llm.chat_provider, Kimi)

    extra_body = llm.chat_provider.model_parameters.get("extra_body") or {}
    # extra_body might be missing entirely (no thinking branch ran), or present
    # with no thinking key. Both are acceptable; what must hold is "no keep".
    thinking = extra_body.get("thinking") or {}
    assert "keep" not in thinking


def test_create_llm_kimi_thinking_keep_injected_on_explicit_thinking_true(monkeypatch):
    """Covers the second half of the ``thinking_on`` condition: a
    thinking-capable (but not always_thinking) model with explicit
    ``thinking=True``. This exercises a different branch of
    ``"always_thinking" in capabilities or (thinking is True and "thinking" in capabilities)``
    than the always-thinking-name-based tests above."""
    monkeypatch.setenv("KIMI_MODEL_THINKING_KEEP", "all")
    provider, model = _make_kimi_plain_model()
    # Model name has no "thinking"/"reason" marker, so derive_model_capabilities
    # returns an empty set; manually granting only the "thinking" capability
    # means always_thinking is NOT in capabilities — thinking_on is driven
    # solely by the explicit thinking=True argument.
    model.capabilities = {"thinking"}

    llm = create_llm(provider, model, thinking=True)
    assert llm is not None
    assert isinstance(llm.chat_provider, Kimi)

    assert llm.chat_provider.model_parameters.get("extra_body") == snapshot(
        {"thinking": {"type": "enabled", "keep": "all"}}
    )

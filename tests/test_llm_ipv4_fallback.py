from __future__ import annotations

import pytest
from pydantic import SecretStr

from kimi_cli.config import LLMModel, LLMProvider
from kimi_cli.llm import augment_provider_with_env_vars, create_llm


@pytest.mark.asyncio
async def test_create_llm_kimi_prefer_ipv4_sets_local_address() -> None:
    provider = LLMProvider(
        type="kimi",
        base_url="https://example.com",
        api_key=SecretStr("sk-test"),
        prefer_ipv4=True,
    )
    model = LLMModel(provider="default", model="kimi-for-coding", max_context_size=100000)

    llm = create_llm(provider, model)
    # unwrap httpx transport pool internals to assert IPv4 binding
    assert hasattr(llm.chat_provider, "client")
    transport = llm.chat_provider.client._client._transport  # type: ignore[attr-defined]
    pool = transport._pool  # type: ignore[attr-defined]
    assert getattr(pool, "_local_address", None) == "0.0.0.0"


def test_augment_provider_with_env_vars_prefer_ipv4(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = LLMProvider(
        type="kimi",
        base_url="https://example.com",
        api_key=SecretStr("sk-test"),
    )
    model = LLMModel(provider="default", model="kimi-for-coding", max_context_size=100000)

    monkeypatch.setenv("KIMI_PREFER_IPV4", "1")
    applied = augment_provider_with_env_vars(provider, model)
    assert provider.prefer_ipv4 is True
    assert applied.get("KIMI_PREFER_IPV4") == "True"

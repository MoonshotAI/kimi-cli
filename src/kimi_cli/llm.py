import os
from typing import NamedTuple

from kosong.base.chat_provider import ChatProvider
from kosong.chat_provider.chaos import ChaosChatProvider, ChaosConfig
from kosong.chat_provider.kimi import Kimi
from kosong.chat_provider.openai_legacy import OpenAILegacy
from pydantic import SecretStr

from kimi_cli.config import LLMModel, LLMProvider
from kimi_cli.constant import USER_AGENT


class LLM(NamedTuple):
    chat_provider: ChatProvider
    max_context_size: int


def augment_provider_with_env_vars(provider: LLMProvider, model: LLMModel):
    match provider.type:
        case "kimi":
            if base_url := os.getenv("KIMI_BASE_URL"):
                provider.base_url = base_url
            if api_key := os.getenv("KIMI_API_KEY"):
                provider.api_key = SecretStr(api_key)
            if model_name := os.getenv("KIMI_MODEL_NAME"):
                model.model = model_name
            if max_context_size := os.getenv("KIMI_MODEL_MAX_CONTEXT_SIZE"):
                model.max_context_size = int(max_context_size)
        case "openai_legacy":
            if base_url := os.getenv("OPENAI_BASE_URL"):
                provider.base_url = base_url
            if api_key := os.getenv("OPENAI_API_KEY"):
                provider.api_key = SecretStr(api_key)
        case _:
            pass


def create_llm(
    provider: LLMProvider,
    model: LLMModel,
    *,
    stream: bool = True,
    session_id: str | None = None,
) -> LLM:
    match provider.type:
        case "kimi":
            chat_provider = Kimi(
                model=model.model,
                base_url=provider.base_url,
                api_key=provider.api_key.get_secret_value(),
                stream=stream,
                default_headers={
                    "User-Agent": USER_AGENT,
                },
            )
            if session_id:
                chat_provider = chat_provider.with_generation_kwargs(prompt_cache_key=session_id)
        case "openai_legacy":
            chat_provider = OpenAILegacy(
                model=model.model,
                base_url=provider.base_url,
                api_key=provider.api_key.get_secret_value(),
                stream=stream,
            )
        case "_chaos":
            chat_provider = ChaosChatProvider(
                model=model.model,
                base_url=provider.base_url,
                api_key=provider.api_key.get_secret_value(),
                chaos_config=ChaosConfig(
                    error_probability=0.8,
                    error_types=[429, 500, 503],
                ),
            )

    return LLM(chat_provider=chat_provider, max_context_size=model.max_context_size)

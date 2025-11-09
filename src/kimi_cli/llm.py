import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, cast, get_args

from kosong.chat_provider import ChatProvider
from pydantic import SecretStr

from kimi_cli.constant import USER_AGENT

if TYPE_CHECKING:
    from kimi_cli.config import LLMModel, LLMProvider

type ProviderType = Literal["kimi", "openai_legacy", "openai_responses", "anthropic", "_chaos"]

type ModelCapability = Literal["image_in", "thinking"]
ALL_MODEL_CAPABILITIES: set[ModelCapability] = set(get_args(ModelCapability))


@dataclass(slots=True)
class LLM:
    chat_provider: ChatProvider
    max_context_size: int
    capabilities: set[ModelCapability]

    @property
    def model_name(self) -> str:
        return self.chat_provider.model_name


def augment_provider_with_env_vars(provider: "LLMProvider", model: "LLMModel") -> dict[str, str]:
    """Override provider/model settings from environment variables.

    Returns:
        Mapping of environment variables that were applied.
    """
    applied: dict[str, str] = {}

    match provider.type:
        case "kimi":
            if base_url := os.getenv("KIMI_BASE_URL"):
                provider.base_url = base_url
                applied["KIMI_BASE_URL"] = base_url
            if api_key := os.getenv("KIMI_API_KEY"):
                provider.api_key = SecretStr(api_key)
                applied["KIMI_API_KEY"] = "******"
            if model_name := os.getenv("KIMI_MODEL_NAME"):
                model.model = model_name
                applied["KIMI_MODEL_NAME"] = model_name
            if max_context_size := os.getenv("KIMI_MODEL_MAX_CONTEXT_SIZE"):
                model.max_context_size = int(max_context_size)
                applied["KIMI_MODEL_MAX_CONTEXT_SIZE"] = max_context_size
            if capabilities := os.getenv("KIMI_MODEL_CAPABILITIES"):
                caps_lower = (cap.strip().lower() for cap in capabilities.split(",") if cap.strip())
                model.capabilities = set(
                    cast(ModelCapability, cap)
                    for cap in caps_lower
                    if cap in get_args(ModelCapability)
                )
                applied["KIMI_MODEL_CAPABILITIES"] = capabilities
        case "openai_legacy" | "openai_responses":
            if base_url := os.getenv("OPENAI_BASE_URL"):
                provider.base_url = base_url
            if api_key := os.getenv("OPENAI_API_KEY"):
                provider.api_key = SecretStr(api_key)
        case _:
            pass

    return applied


def create_llm(
    provider: "LLMProvider",
    model: "LLMModel",
    *,
    stream: bool = True,
    session_id: str | None = None,
) -> LLM:
    match provider.type:
        case "kimi":
            from kosong.chat_provider.kimi import Kimi

            chat_provider = Kimi(
                model=model.model,
                base_url=provider.base_url,
                api_key=provider.api_key.get_secret_value(),
                stream=stream,
                default_headers={
                    "User-Agent": USER_AGENT,
                    **(provider.custom_headers or {}),
                },
            )
            if session_id:
                chat_provider = chat_provider.with_generation_kwargs(prompt_cache_key=session_id)
        case "openai_legacy":
            from kosong.contrib.chat_provider.openai_legacy import OpenAILegacy

            chat_provider = OpenAILegacy(
                model=model.model,
                base_url=provider.base_url,
                api_key=provider.api_key.get_secret_value(),
                stream=stream,
            )
        case "openai_responses":
            from kosong.contrib.chat_provider.openai_responses import OpenAIResponses

            chat_provider = OpenAIResponses(
                model=model.model,
                base_url=provider.base_url,
                api_key=provider.api_key.get_secret_value(),
                stream=stream,
            )
        case "anthropic":
            from kosong.contrib.chat_provider.anthropic import Anthropic

            chat_provider = Anthropic(
                model=model.model,
                base_url=provider.base_url,
                api_key=provider.api_key.get_secret_value(),
                stream=stream,
                default_max_tokens=50000,
            )
        case "_chaos":
            from kosong.chat_provider.chaos import ChaosChatProvider, ChaosConfig

            chat_provider = ChaosChatProvider(
                model=model.model,
                base_url=provider.base_url,
                api_key=provider.api_key.get_secret_value(),
                chaos_config=ChaosConfig(
                    error_probability=0.8,
                    error_types=[429, 500, 503],
                ),
            )

    return LLM(
        chat_provider=chat_provider,
        max_context_size=model.max_context_size,
        capabilities=_derive_capabilities(provider, model),
    )


def _derive_capabilities(provider: "LLMProvider", model: "LLMModel") -> set[ModelCapability]:
    capabilities = model.capabilities or set()
    if provider.type != "kimi":
        return capabilities

    if model.model == "kimi-for-coding" or "thinking" in model.model:
        capabilities.add("thinking")
    return capabilities

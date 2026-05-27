from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, cast, get_args

from kosong.chat_provider import ChatProvider
from pydantic import SecretStr

from kimi_cli.constant import USER_AGENT
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.auth.oauth import OAuthManager
    from kimi_cli.config import Config, LLMModel, LLMProvider
    from kimi_cli.llm_key_pool import APIKeyPool

type ProviderType = Literal[
    "kimi",
    "openai_legacy",
    "openai_responses",
    "anthropic",
    "google_genai",  # for backward-compatibility, equals to `gemini`
    "gemini",
    "vertexai",
    "_echo",
    "_scripted_echo",
    "_chaos",
]

type ModelCapability = Literal["image_in", "video_in", "thinking", "always_thinking"]
ALL_MODEL_CAPABILITIES: set[ModelCapability] = set(get_args(ModelCapability.__value__))


@dataclass(slots=True)
class LLM:
    chat_provider: ChatProvider
    max_context_size: int
    capabilities: set[ModelCapability]
    model_config: LLMModel | None = None
    provider_config: LLMProvider | None = None

    @property
    def model_name(self) -> str:
        return self.chat_provider.model_name


def model_display_name(model_name: str | None, model: LLMModel | None = None) -> str:
    if model is not None and model.display_name:
        return model.display_name
    if not model_name:
        return ""
    if model_name in ("kimi-for-coding", "kimi-code"):
        return "kimi-for-coding"
    return model_name


def augment_provider_with_env_vars(provider: LLMProvider, model: LLMModel) -> dict[str, str]:
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
                    if cap in get_args(ModelCapability.__value__)
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


def _kimi_default_headers(
    provider: LLMProvider,
    oauth: OAuthManager | None,
    extra_headers: dict[str, str] | None = None,
) -> dict[str, str]:
    headers = {"User-Agent": USER_AGENT}
    if oauth:
        headers.update(oauth.common_headers())
    if provider.custom_headers:
        headers.update(provider.custom_headers)
    if extra_headers:
        headers.update(extra_headers)
    return headers


class KeyPoolKimi:
    """Kimi provider wrapper that rotates API keys from a pool on retryable errors.

    This is a thin wrapper applied *after* the normal ``Kimi`` instance is
    created.  It forwards every attribute/method to the underlying provider
    except ``on_retryable_error``, where it swaps in the next key from the
    pool and recreates the HTTP client.
    """

    def __init__(self, provider: Any, key_pool: APIKeyPool) -> None:
        self._provider = provider
        self._key_pool = key_pool
        # Forward all public attributes to the wrapped provider
        self.name = provider.name
        self.model = provider.model
        self.stream = provider.stream

    @property
    def provider(self) -> Any:
        return self._provider

    @property
    def model_name(self) -> str:
        return self._provider.model_name

    @property
    def thinking_effort(self) -> Any:
        return self._provider.thinking_effort

    async def generate(self, *args: Any, **kwargs: Any) -> Any:
        return await self._provider.generate(*args, **kwargs)

    def on_retryable_error(self, error: BaseException) -> bool:
        from kosong.chat_provider.openai_common import (
            close_replaced_openai_client,
            create_openai_client,
        )

        old_client = self._provider.client
        new_key = self._key_pool.acquire()
        self._provider.client = create_openai_client(
            api_key=new_key,
            base_url=self._provider._base_url,
            client_kwargs=self._provider._client_kwargs,
        )
        self._provider._api_key = new_key
        close_replaced_openai_client(old_client, client_kwargs=self._provider._client_kwargs)
        logger.info(
            "Rotated to next API key after retryable error: {error}",
            error=error,
        )
        return True

    def with_thinking(self, *args: Any, **kwargs: Any) -> KeyPoolKimi:
        new_provider = self._provider.with_thinking(*args, **kwargs)
        wrapped = KeyPoolKimi.__new__(KeyPoolKimi)
        wrapped._provider = new_provider
        wrapped._key_pool = self._key_pool
        wrapped.name = new_provider.name
        wrapped.model = new_provider.model
        wrapped.stream = new_provider.stream
        return wrapped

    def with_generation_kwargs(self, *args: Any, **kwargs: Any) -> KeyPoolKimi:
        new_provider = self._provider.with_generation_kwargs(*args, **kwargs)
        wrapped = KeyPoolKimi.__new__(KeyPoolKimi)
        wrapped._provider = new_provider
        wrapped._key_pool = self._key_pool
        wrapped.name = new_provider.name
        wrapped.model = new_provider.model
        wrapped.stream = new_provider.stream
        return wrapped

    def with_extra_body(self, *args: Any, **kwargs: Any) -> KeyPoolKimi:
        new_provider = self._provider.with_extra_body(*args, **kwargs)
        wrapped = KeyPoolKimi.__new__(KeyPoolKimi)
        wrapped._provider = new_provider
        wrapped._key_pool = self._key_pool
        wrapped.name = new_provider.name
        wrapped.model = new_provider.model
        wrapped.stream = new_provider.stream
        return wrapped

    @property
    def model_parameters(self) -> dict[str, Any]:
        return self._provider.model_parameters

    @property
    def files(self) -> Any:
        return self._provider.files


def unwrap_kimi_provider(chat_provider: Any) -> Any:
    """Unwrap a KeyPoolKimi wrapper to get the underlying Kimi provider.

    Returns the original provider unchanged if it is not a KeyPoolKimi.
    This centralises the unwrap logic so that new ``isinstance(..., Kimi)``
    checks do not need to be duplicated across the codebase.
    """
    if isinstance(chat_provider, KeyPoolKimi):
        return chat_provider.provider
    return chat_provider


def create_llm(
    provider: LLMProvider,
    model: LLMModel,
    *,
    thinking: bool | None = None,
    session_id: str | None = None,
    oauth: OAuthManager | None = None,
    api_key_override: str | None = None,
    key_pool: APIKeyPool | None = None,
    extra_headers: dict[str, str] | None = None,
) -> LLM | None:
    if provider.type not in {"_echo", "_scripted_echo"} and (
        not provider.base_url or not model.model
    ):
        logger.warning(
            "Cannot create LLM: missing base_url or model (provider_type={provider_type})",
            provider_type=provider.type,
        )
        return None

    resolved_api_key = api_key_override
    if resolved_api_key is None:
        resolved_api_key = (
            oauth.resolve_api_key(provider.api_key, provider.oauth)
            if oauth and provider.oauth
            else provider.api_key.get_secret_value()
        )
    else:
        logger.info(
            "Creating LLM with overridden API key for provider {provider_type}",
            provider_type=provider.type,
        )

    match provider.type:
        case "kimi":
            from kosong.chat_provider.kimi import Kimi

            chat_provider = Kimi(
                model=model.model,
                base_url=provider.base_url,
                api_key=resolved_api_key,
                default_headers=_kimi_default_headers(provider, oauth, extra_headers),
            )
            if key_pool is not None:
                chat_provider = KeyPoolKimi(chat_provider, key_pool)

            gen_kwargs: Kimi.GenerationKwargs = {}
            if session_id:
                gen_kwargs["prompt_cache_key"] = session_id
            if temperature := os.getenv("KIMI_MODEL_TEMPERATURE"):
                gen_kwargs["temperature"] = float(temperature)
            if top_p := os.getenv("KIMI_MODEL_TOP_P"):
                gen_kwargs["top_p"] = float(top_p)
            if max_tokens := os.getenv("KIMI_MODEL_MAX_TOKENS"):
                gen_kwargs["max_tokens"] = int(max_tokens)

            if gen_kwargs:
                chat_provider = chat_provider.with_generation_kwargs(**gen_kwargs)
        case "openai_legacy":
            from kosong.contrib.chat_provider.openai_legacy import OpenAILegacy

            reasoning_key = (
                provider.reasoning_key
                if provider.reasoning_key is not None
                else "reasoning_content"
            )
            chat_provider = OpenAILegacy(
                model=model.model,
                base_url=provider.base_url,
                api_key=resolved_api_key,
                reasoning_key=reasoning_key,
                default_headers=dict(provider.custom_headers) if provider.custom_headers else None,
            )
        case "openai_responses":
            from kosong.contrib.chat_provider.openai_responses import OpenAIResponses

            chat_provider = OpenAIResponses(
                model=model.model,
                base_url=provider.base_url,
                api_key=resolved_api_key,
                default_headers=dict(provider.custom_headers) if provider.custom_headers else None,
            )
        case "anthropic":
            from kosong.contrib.chat_provider.anthropic import Anthropic

            chat_provider = Anthropic(
                model=model.model,
                base_url=provider.base_url,
                api_key=resolved_api_key,
                default_max_tokens=50000,
                metadata={"user_id": session_id} if session_id else None,
                default_headers=dict(provider.custom_headers) if provider.custom_headers else None,
            )
        case "google_genai" | "gemini":
            from kosong.contrib.chat_provider.google_genai import GoogleGenAI

            chat_provider = GoogleGenAI(
                model=model.model,
                base_url=provider.base_url,
                api_key=resolved_api_key,
                default_headers=dict(provider.custom_headers) if provider.custom_headers else None,
            )
        case "vertexai":
            from kosong.contrib.chat_provider.google_genai import GoogleGenAI

            os.environ.update(provider.env or {})
            chat_provider = GoogleGenAI(
                model=model.model,
                base_url=provider.base_url,
                api_key=resolved_api_key,
                vertexai=True,
                default_headers=dict(provider.custom_headers) if provider.custom_headers else None,
            )
        case "_echo":
            from kosong.chat_provider.echo import EchoChatProvider

            chat_provider = EchoChatProvider()
        case "_scripted_echo":
            from kosong.chat_provider.echo import ScriptedEchoChatProvider

            if provider.env:
                os.environ.update(provider.env)
            scripts = _load_scripted_echo_scripts()
            trace_value = os.getenv("KIMI_SCRIPTED_ECHO_TRACE", "")
            trace = trace_value.strip().lower() in {"1", "true", "yes", "on"}
            chat_provider = ScriptedEchoChatProvider(scripts, trace=trace)
        case "_chaos":
            from kosong.chat_provider.chaos import ChaosChatProvider, ChaosConfig
            from kosong.chat_provider.kimi import Kimi

            chat_provider = ChaosChatProvider(
                provider=Kimi(
                    model=model.model,
                    base_url=provider.base_url,
                    api_key=resolved_api_key,
                    default_headers=_kimi_default_headers(provider, oauth, extra_headers),
                ),
                chaos_config=ChaosConfig(
                    error_probability=0.8,
                    error_types=[429, 500, 503],
                ),
            )

    capabilities = derive_model_capabilities(model)

    # Apply thinking if specified or if model always requires thinking
    thinking_on = "always_thinking" in capabilities or (
        thinking is True and "thinking" in capabilities
    )
    if thinking_on:
        chat_provider = chat_provider.with_thinking("high")
    elif thinking is False:
        chat_provider = chat_provider.with_thinking("off")
    # If thinking is None and model doesn't always think, leave as-is (default behavior)

    # Apply Moonshot-specific ``thinking.keep`` (preserved thinking) only when
    # the model is actually in thinking mode; otherwise the API would see a
    # ``thinking.keep`` without an accompanying ``thinking.type`` it honors.
    if thinking_on and provider.type == "kimi":
        from kosong.chat_provider.kimi import Kimi

        _provider_for_check = unwrap_kimi_provider(chat_provider)

        if isinstance(_provider_for_check, Kimi) and (
            thinking_keep := os.getenv("KIMI_MODEL_THINKING_KEEP")
        ):
            # Both Kimi and KeyPoolKimi implement with_extra_body;
            # pyright cannot narrow via _provider_for_check so we ignore.
            chat_provider = chat_provider.with_extra_body(  # type: ignore[union-attr]
                {"thinking": {"keep": thinking_keep}}
            )

    from typing import cast

    return LLM(
        chat_provider=cast(ChatProvider, chat_provider),
        max_context_size=model.max_context_size,
        capabilities=capabilities,
        model_config=model,
        provider_config=provider,
    )


def clone_llm_with_model_alias(
    llm: LLM | None,
    config: Config,
    model_alias: str | None,
    *,
    session_id: str,
    oauth: OAuthManager | None,
    api_key_override: str | None = None,
    key_pool: APIKeyPool | None = None,
    extra_headers: dict[str, str] | None = None,
) -> LLM | None:
    if model_alias is None:
        # When a key pool is active we must still re-create the LLM so that
        # each subagent gets its own API key (or key-pool wrapper).
        if api_key_override is None and key_pool is None and extra_headers is None:
            return llm
        if llm is None or llm.provider_config is None or llm.model_config is None:
            return llm
        # Re-use the existing provider/model but swap the API key.
        thinking: bool | None = None
        effort = getattr(llm.chat_provider, "thinking_effort", None)
        if effort is not None:
            thinking = effort != "off"
        return create_llm(
            llm.provider_config,
            llm.model_config,
            thinking=thinking,
            session_id=session_id,
            oauth=oauth,
            api_key_override=api_key_override,
            key_pool=key_pool,
            extra_headers=extra_headers,
        )
    if model_alias not in config.models:
        raise KeyError(f"Unknown model alias: {model_alias}")
    model = config.models[model_alias]
    provider = config.providers[model.provider]
    thinking: bool | None = None
    if llm is not None:
        effort = getattr(llm.chat_provider, "thinking_effort", None)
        if effort is not None:
            thinking = effort != "off"
    return create_llm(
        provider,
        model,
        thinking=thinking,
        session_id=session_id,
        oauth=oauth,
        api_key_override=api_key_override,
        key_pool=key_pool,
        extra_headers=extra_headers,
    )


def derive_model_capabilities(model: LLMModel) -> set[ModelCapability]:
    capabilities = set(model.capabilities or ())
    # Models with "thinking" in their name are always-thinking models
    if "thinking" in model.model.lower() or "reason" in model.model.lower():
        capabilities.update(("thinking", "always_thinking"))
    # These models support thinking but can be toggled on/off
    elif model.model in {"kimi-for-coding", "kimi-code"}:
        capabilities.update(("thinking", "image_in", "video_in"))
    return capabilities


def _load_scripted_echo_scripts() -> list[str]:
    script_path = os.getenv("KIMI_SCRIPTED_ECHO_SCRIPTS")
    if not script_path:
        raise ValueError("KIMI_SCRIPTED_ECHO_SCRIPTS is required for _scripted_echo.")
    path = Path(script_path).expanduser()
    if not path.exists():
        raise ValueError(f"Scripted echo file not found: {path}")
    text = path.read_text(encoding="utf-8")
    try:
        data: object = json.loads(text)
    except json.JSONDecodeError:
        scripts = [chunk.strip() for chunk in text.split("\n---\n") if chunk.strip()]
        if scripts:
            return scripts
        raise ValueError(
            "Scripted echo file must be a JSON array of strings or a text file "
            "split by '\\n---\\n'."
        ) from None
    if isinstance(data, list):
        data_list = cast(list[object], data)
        if all(isinstance(item, str) for item in data_list):
            return cast(list[str], data_list)
    raise ValueError("Scripted echo JSON must be an array of strings.")

from __future__ import annotations

import json
import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, cast, get_args

from kosong.chat_provider import ChatProvider
from kosong.message import (
    AudioURLPart,
    ImageURLPart,
    Message,
    TextPart,
    ThinkPart,
    VideoURLPart,
)
from kosong.tooling import Tool
from pydantic import SecretStr

from kimi_cli.constant import USER_AGENT
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kosong.chat_provider.kimi import Kimi

    from kimi_cli.auth.oauth import OAuthManager
    from kimi_cli.config import Config, LLMModel, LLMProvider

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
DEFAULT_UNKNOWN_CONTEXT_COMPLETION_TOKENS = 32_000
DEFAULT_COMPLETION_TOKEN_SAFETY_MARGIN = 1_024
MEDIA_TOKEN_ESTIMATE = 2_000


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


def find_kimi_provider(chat_provider: ChatProvider) -> Kimi | None:
    """Return the Kimi provider backing a supported provider wrapper."""
    from kosong.chat_provider.chaos import ChaosChatProvider
    from kosong.chat_provider.kimi import Kimi

    provider = chat_provider
    while isinstance(provider, ChaosChatProvider):
        provider = provider.wrapped_provider
    return provider if isinstance(provider, Kimi) else None


def compute_max_completion_tokens(
    *,
    max_context_size: int,
    input_tokens: int,
    response_budget: int | None,
    fallback_budget: int = DEFAULT_UNKNOWN_CONTEXT_COMPLETION_TOKENS,
) -> int:
    """Compute the Kimi completion cap from the hard cap and remaining context."""
    if max_context_size <= 0:
        return max(1, response_budget if response_budget is not None else fallback_budget)

    input_tokens = max(0, input_tokens)
    remaining = max(1, max_context_size - input_tokens)
    requested = response_budget if response_budget is not None else max_context_size
    return max(1, min(requested, remaining))


def estimate_request_tokens(
    system_prompt: str,
    tools: Sequence[Tool],
    history: Sequence[Message],
) -> int:
    """Estimate all token-bearing parts of a chat request.

    The estimate is deliberately request-scoped: unlike ``Context.token_count_with_pending``,
    it includes the system prompt, tool schemas, message metadata, tool calls, and media. Exact
    tokenization is provider/model specific, so callers should still reserve a small safety
    margin when using the result to derive a hard completion limit.
    """
    return (
        _estimate_text_tokens(system_prompt)
        + sum(_estimate_tool_tokens(tool) for tool in tools)
        + sum(_estimate_message_tokens(message) for message in history)
    )


def estimate_message_tokens(messages: Sequence[Message]) -> int:
    """Estimate token-bearing content for messages added outside the main context."""
    return sum(_estimate_message_tokens(message) for message in messages)


def _estimate_text_tokens(text: str) -> int:
    ascii_count = sum(char.isascii() for char in text)
    non_ascii_count = len(text) - ascii_count
    return (ascii_count + 3) // 4 + non_ascii_count


def _estimate_tool_tokens(tool: Tool) -> int:
    return (
        _estimate_text_tokens(tool.name)
        + _estimate_text_tokens(tool.description)
        + _estimate_text_tokens(
            json.dumps(tool.parameters, ensure_ascii=False, separators=(",", ":"))
        )
    )


def _estimate_message_tokens(message: Message) -> int:
    total = _estimate_text_tokens(message.role)
    if message.name:
        total += _estimate_text_tokens(message.name)
    if message.tool_call_id:
        total += _estimate_text_tokens(message.tool_call_id)

    for part in message.content:
        if isinstance(part, TextPart):
            total += _estimate_text_tokens(part.text)
        elif isinstance(part, ThinkPart):
            total += _estimate_text_tokens(part.think)
        elif isinstance(part, (ImageURLPart, AudioURLPart, VideoURLPart)):
            total += MEDIA_TOKEN_ESTIMATE
        else:
            total += _estimate_text_tokens(part.model_dump_json(exclude_none=True))

    for tool_call in message.tool_calls or ():
        total += _estimate_text_tokens(tool_call.id)
        total += _estimate_text_tokens(tool_call.function.name)
        total += _estimate_text_tokens(tool_call.function.arguments or "")
        if tool_call.extras:
            total += _estimate_text_tokens(
                json.dumps(tool_call.extras, ensure_ascii=False, separators=(",", ":"))
            )
    return total


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


def _kimi_default_headers(provider: LLMProvider, oauth: OAuthManager | None) -> dict[str, str]:
    headers = {"User-Agent": USER_AGENT}
    if oauth:
        headers.update(oauth.common_headers())
    if provider.custom_headers:
        headers.update(provider.custom_headers)
    return headers


def create_llm(
    provider: LLMProvider,
    model: LLMModel,
    *,
    thinking: bool | None = None,
    session_id: str | None = None,
    oauth: OAuthManager | None = None,
) -> LLM | None:
    if provider.type not in {"_echo", "_scripted_echo"} and (
        not provider.base_url or not model.model
    ):
        logger.warning(
            "Cannot create LLM: missing base_url or model (provider_type={provider_type})",
            provider_type=provider.type,
        )
        return None

    resolved_api_key = (
        oauth.resolve_api_key(provider.api_key, provider.oauth)
        if oauth and provider.oauth
        else provider.api_key.get_secret_value()
    )

    match provider.type:
        case "kimi":
            from kosong.chat_provider.kimi import Kimi

            chat_provider = Kimi(
                model=model.model,
                base_url=provider.base_url,
                api_key=resolved_api_key,
                default_headers=_kimi_default_headers(provider, oauth),
            )

            gen_kwargs: Kimi.GenerationKwargs = {}
            if session_id:
                gen_kwargs["prompt_cache_key"] = session_id
            if temperature := os.getenv("KIMI_MODEL_TEMPERATURE"):
                gen_kwargs["temperature"] = float(temperature)
            if top_p := os.getenv("KIMI_MODEL_TOP_P"):
                gen_kwargs["top_p"] = float(top_p)
            for env_name in (
                "KIMI_MODEL_MAX_COMPLETION_TOKENS",
                "KIMI_MODEL_MAX_TOKENS",
            ):
                raw_max_completion_tokens = os.getenv(env_name)
                if not raw_max_completion_tokens:
                    continue
                try:
                    max_completion_tokens = int(raw_max_completion_tokens)
                except ValueError:
                    continue
                # ``None`` is an explicit opt-out marker consumed by KimiSoul. Kimi's
                # request serializer omits it when no per-call override is supplied.
                gen_kwargs["max_completion_tokens"] = (
                    max_completion_tokens if max_completion_tokens > 0 else None
                )
                break

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
                    default_headers=_kimi_default_headers(provider, oauth),
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

        if isinstance(chat_provider, Kimi) and (
            thinking_keep := os.getenv("KIMI_MODEL_THINKING_KEEP")
        ):
            chat_provider = chat_provider.with_extra_body({"thinking": {"keep": thinking_keep}})

    return LLM(
        chat_provider=chat_provider,
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
) -> LLM | None:
    if model_alias is None:
        return llm
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

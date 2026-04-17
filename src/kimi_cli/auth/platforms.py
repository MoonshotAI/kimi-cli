from __future__ import annotations

import os
from typing import Any, Literal, NamedTuple, cast

import aiohttp
from pydantic import BaseModel

from kimi_cli.auth import KIMI_CODE_PLATFORM_ID
from kimi_cli.config import Config, LLMModel, load_config, save_config
from kimi_cli.llm import ModelCapability
from kimi_cli.utils.aiohttp import new_client_session
from kimi_cli.utils.logging import logger

BEDROCK_MANTLE_PLATFORM_ID = "bedrock-mantle"

BEDROCK_MANTLE_REGIONS: list[tuple[str, str]] = [
    ("us-east-1", "US East (N. Virginia)"),
    ("us-east-2", "US East (Ohio)"),
    ("us-west-2", "US West (Oregon)"),
    ("eu-west-1", "Europe (Ireland)"),
    ("eu-west-2", "Europe (London)"),
    ("eu-central-1", "Europe (Frankfurt)"),
    ("ap-south-1", "Asia Pacific (Mumbai)"),
    ("ap-northeast-1", "Asia Pacific (Tokyo)"),
    ("ap-southeast-3", "Asia Pacific (Jakarta)"),
    ("sa-east-1", "South America (São Paulo)"),
    ("eu-south-1", "Europe (Milan)"),
    ("eu-north-1", "Europe (Stockholm)"),
]


def bedrock_mantle_base_url(region: str) -> str:
    """OpenAI-compatible Bedrock Mantle base URL (includes ``/v1`` prefix)."""
    return f"https://bedrock-mantle.{region}.api.aws/v1"


class ModelInfo(BaseModel):
    """Model information returned from the API."""

    id: str
    context_length: int
    supports_reasoning: bool
    supports_image_in: bool
    supports_video_in: bool

    @property
    def capabilities(self) -> set[ModelCapability]:
        """Derive capabilities from model info."""
        caps: set[ModelCapability] = set()
        if self.supports_reasoning:
            caps.add("thinking")
        # Models with "thinking" in name are always-thinking
        if "thinking" in self.id.lower():
            caps.update(("thinking", "always_thinking"))
        if self.supports_image_in:
            caps.add("image_in")
        if self.supports_video_in:
            caps.add("video_in")
        if self.id.lower().startswith("kimi-k2"):
            caps.update(("thinking", "image_in", "video_in"))
        return caps


class Platform(NamedTuple):
    id: str
    name: str
    base_url: str
    search_url: str | None = None
    fetch_url: str | None = None
    allowed_prefixes: list[str] | None = None
    llm_provider_type: Literal["kimi", "openai_legacy"] = "kimi"


def _kimi_code_base_url() -> str:
    if base_url := os.getenv("KIMI_CODE_BASE_URL"):
        return base_url
    return "https://api.kimi.com/coding/v1"


PLATFORMS: list[Platform] = [
    Platform(
        id=BEDROCK_MANTLE_PLATFORM_ID,
        name="AWS Bedrock Mantle (OpenAI-compatible)",
        base_url="",
        llm_provider_type="openai_legacy",
    ),
    Platform(
        id=KIMI_CODE_PLATFORM_ID,
        name="Kimi Code",
        base_url=_kimi_code_base_url(),
        search_url=f"{_kimi_code_base_url()}/search",
        fetch_url=f"{_kimi_code_base_url()}/fetch",
    ),
    Platform(
        id="moonshot-cn",
        name="Moonshot AI Open Platform (moonshot.cn)",
        base_url="https://api.moonshot.cn/v1",
        allowed_prefixes=["kimi-k"],
    ),
    Platform(
        id="moonshot-ai",
        name="Moonshot AI Open Platform (moonshot.ai)",
        base_url="https://api.moonshot.ai/v1",
        allowed_prefixes=["kimi-k"],
    ),
]

_PLATFORM_BY_ID = {platform.id: platform for platform in PLATFORMS}
_PLATFORM_BY_NAME = {platform.name: platform for platform in PLATFORMS}


def get_platform_by_id(platform_id: str) -> Platform | None:
    return _PLATFORM_BY_ID.get(platform_id)


def get_platform_by_name(name: str) -> Platform | None:
    return _PLATFORM_BY_NAME.get(name)


MANAGED_PROVIDER_PREFIX = "managed:"


def managed_provider_key(platform_id: str) -> str:
    return f"{MANAGED_PROVIDER_PREFIX}{platform_id}"


def managed_model_key(platform_id: str, model_id: str) -> str:
    return f"{platform_id}/{model_id}"


def parse_managed_provider_key(provider_key: str) -> str | None:
    if not provider_key.startswith(MANAGED_PROVIDER_PREFIX):
        return None
    return provider_key.removeprefix(MANAGED_PROVIDER_PREFIX)


def is_managed_provider_key(provider_key: str) -> bool:
    return provider_key.startswith(MANAGED_PROVIDER_PREFIX)


def get_platform_name_for_provider(provider_key: str) -> str | None:
    platform_id = parse_managed_provider_key(provider_key)
    if not platform_id:
        return None
    platform = get_platform_by_id(platform_id)
    return platform.name if platform else None


async def refresh_managed_models(config: Config) -> bool:
    if not config.is_from_default_location:
        return False

    managed_providers = {
        key: provider for key, provider in config.providers.items() if is_managed_provider_key(key)
    }
    if not managed_providers:
        return False

    changed = False
    updates: list[tuple[str, str, list[ModelInfo]]] = []
    for provider_key, provider in managed_providers.items():
        platform_id = parse_managed_provider_key(provider_key)
        if not platform_id:
            continue
        platform = get_platform_by_id(platform_id)
        if platform is None:
            logger.warning("Managed platform not found: {platform}", platform=platform_id)
            continue

        api_key = provider.api_key.get_secret_value()
        if not api_key and provider.oauth:
            from kimi_cli.auth.oauth import load_tokens

            token = load_tokens(provider.oauth)
            if token:
                api_key = token.access_token
        if not api_key:
            logger.warning(
                "Missing API key for managed provider: {provider}",
                provider=provider_key,
            )
            continue
        list_url = (provider.base_url or "").strip() or (platform.base_url or "").strip()
        if not list_url:
            logger.warning(
                "Missing base URL for managed provider: {provider}",
                provider=provider_key,
            )
            continue
        try:
            models = await list_models(platform, api_key, list_base_url=list_url)
        except Exception as exc:
            logger.error(
                "Failed to refresh models for {platform}: {error}",
                platform=platform_id,
                error=exc,
            )
            continue

        updates.append((provider_key, platform_id, models))
        if _apply_models(config, provider_key, platform_id, models):
            changed = True

    if changed:
        config_for_save = load_config()
        save_changed = False
        for provider_key, platform_id, models in updates:
            if _apply_models(config_for_save, provider_key, platform_id, models):
                save_changed = True
        if save_changed:
            save_config(config_for_save)
    return changed


async def list_models(
    platform: Platform,
    api_key: str,
    *,
    list_base_url: str | None = None,
) -> list[ModelInfo]:
    effective_base = (list_base_url if list_base_url is not None else platform.base_url).strip()
    if not effective_base:
        raise ValueError("base URL is required to list models")
    openai_compatible = platform.llm_provider_type == "openai_legacy"
    async with new_client_session() as session:
        models = await _list_models(
            session,
            base_url=effective_base,
            api_key=api_key,
            openai_compatible=openai_compatible,
        )
    if platform.allowed_prefixes is None:
        return models
    prefixes = tuple(platform.allowed_prefixes)
    return [model for model in models if model.id.startswith(prefixes)]


def _model_info_from_models_payload_item(
    item: dict[str, Any], *, openai_compatible: bool
) -> ModelInfo | None:
    model_id = item.get("id")
    if not model_id:
        return None
    mid = str(model_id)
    if openai_compatible:
        raw_ctx = item.get("context_length")
        context_length = 0
        if raw_ctx is not None and str(raw_ctx).strip():
            try:
                context_length = max(0, int(raw_ctx))
            except (TypeError, ValueError):
                context_length = 0
        if context_length == 0:
            lower = mid.lower()
            context_length = (
                131_072 if "kimi" in lower or "moonshotai" in lower else 128_000
            )
        return ModelInfo(
            id=mid,
            context_length=context_length,
            supports_reasoning=bool(item.get("supports_reasoning")),
            supports_image_in=bool(item.get("supports_image_in")),
            supports_video_in=bool(item.get("supports_video_in")),
        )
    return ModelInfo(
        id=mid,
        context_length=int(item.get("context_length") or 0),
        supports_reasoning=bool(item.get("supports_reasoning")),
        supports_image_in=bool(item.get("supports_image_in")),
        supports_video_in=bool(item.get("supports_video_in")),
    )


async def _list_models(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    api_key: str,
    openai_compatible: bool = False,
) -> list[ModelInfo]:
    models_url = f"{base_url.rstrip('/')}/models"
    try:
        async with session.get(
            models_url,
            headers={"Authorization": f"Bearer {api_key}"},
            raise_for_status=True,
        ) as response:
            resp_json = await response.json()
    except aiohttp.ClientError:
        raise

    data = resp_json.get("data")
    if not isinstance(data, list):
        raise ValueError(f"Unexpected models response for {base_url}")

    result: list[ModelInfo] = []
    for item in cast(list[dict[str, Any]], data):
        info = _model_info_from_models_payload_item(item, openai_compatible=openai_compatible)
        if info is not None:
            result.append(info)
    return result


def _apply_models(
    config: Config,
    provider_key: str,
    platform_id: str,
    models: list[ModelInfo],
) -> bool:
    changed = False
    model_keys: list[str] = []

    for model in models:
        model_key = managed_model_key(platform_id, model.id)
        model_keys.append(model_key)

        existing = config.models.get(model_key)
        capabilities = model.capabilities or None  # empty set -> None

        if existing is None:
            config.models[model_key] = LLMModel(
                provider=provider_key,
                model=model.id,
                max_context_size=model.context_length,
                capabilities=capabilities,
            )
            changed = True
            continue

        if existing.provider != provider_key:
            existing.provider = provider_key
            changed = True
        if existing.model != model.id:
            existing.model = model.id
            changed = True
        if existing.max_context_size != model.context_length:
            existing.max_context_size = model.context_length
            changed = True
        if existing.capabilities != capabilities:
            existing.capabilities = capabilities
            changed = True

    removed_default = False
    model_keys_set = set(model_keys)
    for key, model in list(config.models.items()):
        if model.provider != provider_key:
            continue
        if key in model_keys_set:
            continue
        del config.models[key]
        if config.default_model == key:
            removed_default = True
        changed = True

    if removed_default:
        if model_keys:
            config.default_model = model_keys[0]
        else:
            config.default_model = next(iter(config.models), "")
        changed = True

    if config.default_model and config.default_model not in config.models:
        config.default_model = next(iter(config.models), "")
        changed = True

    return changed

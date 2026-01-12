from __future__ import annotations

from typing import Any, NamedTuple, cast

import aiohttp
from pydantic import BaseModel

from kimi_cli.config import Config, LLMModel, save_config
from kimi_cli.llm import ModelCapability
from kimi_cli.utils.aiohttp import new_client_session
from kimi_cli.utils.logging import logger


class ModelInfo(BaseModel):
    """Model information returned from the API."""

    id: str
    context_length: int = 0
    supports_reasoning: bool = False

    @property
    def capabilities(self) -> set[ModelCapability]:
        """Derive capabilities from model info."""
        caps: set[ModelCapability] = set()
        if self.supports_reasoning:
            caps.add("thinking")
        # Models with "thinking" in name are always-thinking
        if "thinking" in self.id.lower():
            caps.update(("thinking", "always_thinking"))
        return caps


class Platform(NamedTuple):
    id: str
    name: str
    base_url: str
    search_url: str | None = None
    fetch_url: str | None = None
    allowed_prefixes: list[str] | None = None


PLATFORMS: list[Platform] = [
    Platform(
        id="kimi-code",
        name="Kimi Code",
        base_url="https://api.kimi.com/coding/v1",
        search_url="https://api.kimi.com/coding/v1/search",
        fetch_url="https://api.kimi.com/coding/v1/fetch",
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
    for provider_key, provider in managed_providers.items():
        platform_id = parse_managed_provider_key(provider_key)
        if not platform_id:
            continue
        platform = get_platform_by_id(platform_id)
        if platform is None:
            logger.warning("Managed platform not found: {platform}", platform=platform_id)
            continue

        try:
            models = await list_models(platform, provider.api_key.get_secret_value())
        except Exception as exc:
            logger.error(
                "Failed to refresh models for {platform}: {error}",
                platform=platform_id,
                error=exc,
            )
            continue

        if _apply_models(config, provider_key, platform_id, models):
            changed = True

    if changed:
        save_config(config)
    return changed


async def list_models(platform: Platform, api_key: str) -> list[ModelInfo]:
    async with new_client_session() as session:
        models = await _list_models(
            session,
            base_url=platform.base_url,
            api_key=api_key,
        )
    if platform.allowed_prefixes is None:
        return models
    prefixes = tuple(platform.allowed_prefixes)
    return [model for model in models if model.id.startswith(prefixes)]


async def _list_models(
    session: aiohttp.ClientSession,
    *,
    base_url: str,
    api_key: str,
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
        model_id = item.get("id")
        if not model_id:
            continue
        result.append(
            ModelInfo(
                id=str(model_id),
                context_length=int(item.get("context_length") or 0),
                supports_reasoning=bool(item.get("supports_reasoning")),
            )
        )
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

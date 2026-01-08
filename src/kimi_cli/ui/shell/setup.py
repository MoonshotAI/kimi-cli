from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, NamedTuple

from loguru import logger
from prompt_toolkit import PromptSession
from prompt_toolkit.shortcuts.choice_input import ChoiceInput
from pydantic import SecretStr

from kimi_cli.config import (
    LLMModel,
    LLMProvider,
    MoonshotFetchConfig,
    MoonshotSearchConfig,
    load_config,
    save_config,
)
from kimi_cli.platforms import (
    PLATFORMS,
    Platform,
    get_platform_by_name,
    list_models,
    managed_model_key,
    managed_provider_key,
)
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.slash import registry

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell


@registry.command
async def setup(app: Shell, args: str):
    """Setup Kimi CLI"""
    result = await _setup()
    if not result:
        # error message already printed
        return

    config = load_config()
    provider_key = managed_provider_key(result.platform.id)
    model_key = managed_model_key(result.platform.id, result.selected_model_id)
    config.providers[provider_key] = LLMProvider(
        type="kimi",
        base_url=result.platform.base_url,
        api_key=result.api_key,
    )
    for key, model in list(config.models.items()):
        if model.provider == provider_key:
            del config.models[key]
    for model_info in result.models:
        model_id = model_info.get("id")
        if not model_id:
            continue
        config.models[managed_model_key(result.platform.id, str(model_id))] = LLMModel(
            provider=provider_key,
            model=str(model_id),
            max_context_size=int(model_info.get("context_length") or 0),
        )
    config.default_model = model_key

    if result.platform.search_url:
        config.services.moonshot_search = MoonshotSearchConfig(
            base_url=result.platform.search_url,
            api_key=result.api_key,
        )

    if result.platform.fetch_url:
        config.services.moonshot_fetch = MoonshotFetchConfig(
            base_url=result.platform.fetch_url,
            api_key=result.api_key,
        )

    save_config(config)
    console.print("[green]✓[/green] Kimi CLI has been setup! Reloading...")
    await asyncio.sleep(1)
    console.clear()

    from kimi_cli.cli import Reload

    raise Reload


class _SetupResult(NamedTuple):
    platform: Platform
    api_key: SecretStr
    selected_model_id: str
    models: list[dict[str, Any]]


async def _setup() -> _SetupResult | None:
    # select the API platform
    platform_name = await _prompt_choice(
        header="Select the API platform",
        choices=[platform.name for platform in PLATFORMS],
    )
    if not platform_name:
        console.print("[red]No platform selected[/red]")
        return None

    platform = get_platform_by_name(platform_name)
    if platform is None:
        console.print("[red]Unknown platform[/red]")
        return None

    # enter the API key
    api_key = await _prompt_text("Enter your API key", is_password=True)
    if not api_key:
        return None

    # list models
    try:
        models = await list_models(platform, api_key)
    except Exception as e:
        logger.error("Failed to get models: {error}", error=e)
        console.print(f"[red]Failed to get models: {e}[/red]")
        return None

    # select the model
    model_map = {model["id"]: model for model in models if model.get("id")}
    model_ids = list(model_map)

    if not model_ids:
        console.print("[red]No models available for the selected platform[/red]")
        return None

    model_id = await _prompt_choice(
        header="Select the model",
        choices=model_ids,
    )
    if not model_id:
        console.print("[red]No model selected[/red]")
        return None

    return _SetupResult(
        platform=platform,
        api_key=SecretStr(api_key),
        selected_model_id=model_id,
        models=list(model_map.values()),
    )


async def _prompt_choice(*, header: str, choices: list[str]) -> str | None:
    if not choices:
        return None

    try:
        return await ChoiceInput(
            message=header,
            options=[(choice, choice) for choice in choices],
            default=choices[0],
        ).prompt_async()
    except (EOFError, KeyboardInterrupt):
        return None


async def _prompt_text(prompt: str, *, is_password: bool = False) -> str | None:
    session = PromptSession[str]()
    try:
        return str(
            await session.prompt_async(
                f" {prompt}: ",
                is_password=is_password,
            )
        ).strip()
    except (EOFError, KeyboardInterrupt):
        return None


@registry.command
def reload(app: Shell, args: str):
    """Reload configuration"""
    from kimi_cli.cli import Reload

    raise Reload

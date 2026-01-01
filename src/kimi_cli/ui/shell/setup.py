from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, NamedTuple

import aiohttp
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
from kimi_cli.soul.kimisoul import RESERVED_TOKENS
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.slash import registry
from kimi_cli.utils.aiohttp import new_client_session

# Minimum context size must be at least RESERVED_TOKENS
MIN_CONTEXT_SIZE = RESERVED_TOKENS
DEFAULT_LOCAL_CONTEXT_SIZE = 131072  # 128k for local models

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell


class _Platform(NamedTuple):
    id: str
    name: str
    base_url: str
    search_url: str | None = None
    fetch_url: str | None = None
    allowed_prefixes: list[str] | None = None
    provider_type: str = "kimi"
    is_local: bool = False


_PLATFORMS = [
    _Platform(
        id="kimi-for-coding",
        name="Kimi for Coding",
        base_url="https://api.kimi.com/coding/v1",
        search_url="https://api.kimi.com/coding/v1/search",
        fetch_url="https://api.kimi.com/coding/v1/fetch",
    ),
    _Platform(
        id="moonshot-cn",
        name="Moonshot AI 开放平台 (moonshot.cn)",
        base_url="https://api.moonshot.cn/v1",
        allowed_prefixes=["kimi-k2-"],
    ),
    _Platform(
        id="moonshot-ai",
        name="Moonshot AI Open Platform (moonshot.ai)",
        base_url="https://api.moonshot.ai/v1",
        allowed_prefixes=["kimi-k2-"],
    ),
    _Platform(
        id="lm-studio",
        name="LM Studio (Local)",
        base_url="http://localhost:1234/v1",
        provider_type="lm_studio",
        is_local=True,
    ),
]


@registry.command
async def setup(app: Shell, args: list[str]):
    """Setup Kimi CLI"""
    result = await _setup()
    if not result:
        # error message already printed
        return

    config = load_config()
    config.providers[result.platform.id] = LLMProvider(
        type=result.platform.provider_type,  # type: ignore[arg-type]
        base_url=result.base_url,
        api_key=result.api_key,
    )
    config.models[result.model_id] = LLMModel(
        provider=result.platform.id,
        model=result.model_id,
        max_context_size=result.max_context_size,
    )
    config.default_model = result.model_id

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
    platform: _Platform
    base_url: str
    api_key: SecretStr
    model_id: str
    max_context_size: int


async def _setup() -> _SetupResult | None:
    # select the API platform
    platform_name = await _prompt_choice(
        header="Select the API platform",
        choices=[platform.name for platform in _PLATFORMS],
    )
    if not platform_name:
        console.print("[red]No platform selected[/red]")
        return None

    platform = next(platform for platform in _PLATFORMS if platform.name == platform_name)

    # For local servers (LM Studio), use a different setup flow
    if platform.is_local:
        return await _setup_local(platform)

    # enter the API key
    api_key = await _prompt_text("Enter your API key", is_password=True)
    if not api_key:
        return None

    # list models
    models_url = f"{platform.base_url}/models"
    try:
        async with (
            new_client_session() as session,
            session.get(
                models_url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                },
                raise_for_status=True,
            ) as response,
        ):
            resp_json = await response.json()
    except aiohttp.ClientError as e:
        console.print(f"[red]Failed to get models: {e}[/red]")
        return None

    model_dict = {model["id"]: model for model in resp_json["data"]}

    # select the model
    model_ids: list[str] = [model["id"] for model in resp_json["data"]]
    if platform.allowed_prefixes is not None:
        model_ids = [
            model_id
            for model_id in model_ids
            if model_id.startswith(tuple(platform.allowed_prefixes))
        ]

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

    model = model_dict[model_id]

    return _SetupResult(
        platform=platform,
        base_url=platform.base_url,
        api_key=SecretStr(api_key),
        model_id=model_id,
        max_context_size=model["context_length"],
    )


async def _setup_local(platform: _Platform) -> _SetupResult | None:
    """Setup flow for local servers like LM Studio."""
    import httpx

    # Ask for base URL with default
    base_url = await _prompt_text(f"Enter server URL (default: {platform.base_url})")
    if not base_url:
        base_url = platform.base_url

    # Try to get models from local server
    console.print(f"[dim]Connecting to {base_url}...[/dim]")
    try:
        # Use explicit transport for LM Studio compatibility
        transport = httpx.AsyncHTTPTransport()
        async with httpx.AsyncClient(transport=transport, timeout=10.0) as client:
            resp = await client.get(f"{base_url}/models")
            resp.raise_for_status()
            resp_json = resp.json()
    except Exception as e:
        console.print(f"[red]Failed to connect to {base_url}: {e}[/red]")
        console.print("[yellow]Make sure LM Studio is running and a model is loaded.[/yellow]")
        return None

    model_ids: list[str] = [model["id"] for model in resp_json.get("data", [])]
    if not model_ids:
        console.print("[red]No models found. Make sure a model is loaded in LM Studio.[/red]")
        return None

    # Select model
    model_id = await _prompt_choice(
        header="Select the model",
        choices=model_ids,
    )
    if not model_id:
        console.print("[red]No model selected[/red]")
        return None

    # Ask for context size
    context_size_str = await _prompt_text(
        f"Enter max context size (default: {DEFAULT_LOCAL_CONTEXT_SIZE}, min: {MIN_CONTEXT_SIZE})"
    )
    try:
        max_context_size = int(context_size_str) if context_size_str else DEFAULT_LOCAL_CONTEXT_SIZE
    except ValueError:
        max_context_size = DEFAULT_LOCAL_CONTEXT_SIZE

    # Ensure context size meets minimum requirement
    if max_context_size < MIN_CONTEXT_SIZE:
        console.print(
            f"[yellow]Context size {max_context_size} is below minimum ({MIN_CONTEXT_SIZE}). "
            f"Using {MIN_CONTEXT_SIZE} instead.[/yellow]"
        )
        max_context_size = MIN_CONTEXT_SIZE

    return _SetupResult(
        platform=platform,
        base_url=base_url,
        api_key=SecretStr("lm-studio"),  # LM Studio doesn't require API key
        model_id=model_id,
        max_context_size=max_context_size,
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
def reload(app: Shell, args: list[str]):
    """Reload configuration"""
    from kimi_cli.cli import Reload

    raise Reload

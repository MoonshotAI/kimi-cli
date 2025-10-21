import asyncio
from enum import Enum
from typing import TYPE_CHECKING, NamedTuple

import aiohttp
from prompt_toolkit import PromptSession
from prompt_toolkit.shortcuts.choice_input import ChoiceInput
from pydantic import SecretStr

from kimi_cli.config import LLMModel, LLMProvider, MoonshotSearchConfig, load_config, save_config
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.metacmd import meta_command

if TYPE_CHECKING:
    from kimi_cli.ui.shell import ShellApp


class _PlatformKind(Enum):
    KIMI_CODING = "kimi-coding"
    MOONSHOT_CN = "moonshot-cn"
    MOONSHOT_AI = "moonshot-ai"


class _Platform(NamedTuple):
    name: str
    base_url: str
    allowed_models: list[str] | None = None


_PLATFORMS = {
    _PlatformKind.KIMI_CODING: _Platform(
        name="Kimi Coding Plan",
        base_url="https://kimi.com/coding/v1",
    ),
    _PlatformKind.MOONSHOT_CN: _Platform(
        name="Moonshot AI 开放平台",
        base_url="https://api.moonshot.cn/v1",
        allowed_models=["kimi-k2-turbo-preview", "kimi-k2-0905-preview", "kimi-k2-0711-preview"],
    ),
    _PlatformKind.MOONSHOT_AI: _Platform(
        name="Moonshot AI Open Platform",
        base_url="https://api.moonshot.ai/v1",
        allowed_models=["kimi-k2-turbo-preview", "kimi-k2-0905-preview", "kimi-k2-0711-preview"],
    ),
}


@meta_command(kimi_soul_only=True)
async def setup(app: "ShellApp", args: list[str]):
    """Setup LLM provider and model."""
    assert isinstance(app.soul, KimiSoul)

    result = await _setup()
    if not result:
        # error message already printed
        return

    config = load_config()
    config.providers[result.platform_kind.value] = LLMProvider(
        type="kimi",
        base_url=result.base_url,
        api_key=result.api_key,
    )
    config.models[result.model_id] = LLMModel(
        provider=result.platform_kind.value,
        model=result.model_id,
        max_context_size=result.max_context_size,
    )
    config.default_model = result.model_id

    if result.platform_kind in [
        _PlatformKind.KIMI_CODING,
        _PlatformKind.MOONSHOT_CN,
    ]:
        config.services.moonshot_search = MoonshotSearchConfig(
            base_url="https://search.saas.moonshot.cn/v1/search",
            api_key=result.api_key,
        )

    save_config(config)
    console.print("[bold green]✓[/bold green] Kimi CLI has been setup! Reloading...")
    await asyncio.sleep(1)
    console.clear()

    from kimi_cli import Reload

    raise Reload


class _SetupResult(NamedTuple):
    platform_kind: _PlatformKind
    base_url: str
    api_key: SecretStr
    model_id: str
    max_context_size: int


async def _setup() -> _SetupResult | None:
    # select the API platform
    platform_name = await _prompt_choice(
        header="Select the API platform",
        choices=[platform.name for platform in _PLATFORMS.values()],
    )
    if not platform_name:
        console.print("[bold red]No platform selected[/bold red]")
        return None

    platform_kind = next(
        platform_key
        for platform_key, platform in _PLATFORMS.items()
        if platform.name == platform_name
    )
    assert platform_kind is not None
    platform = _PLATFORMS[platform_kind]

    # enter the API key
    api_key = await _prompt_text("Enter your API key", is_password=True)
    if not api_key:
        return None

    # list models
    models_url = f"{platform.base_url}/models"
    try:
        async with (
            aiohttp.ClientSession() as session,
            session.get(
                models_url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                },
                raise_for_status=True,
            ) as response,
        ):
            json = await response.json()
    except aiohttp.ClientError as e:
        console.print(f"[bold red]Failed to get models: {e}[/bold red]")
        return None

    # select the model
    if platform.allowed_models is None:
        model_ids = [model["id"] for model in json["data"]]
    else:
        id_set = set(model["id"] for model in json["data"])
        model_ids = [model_id for model_id in platform.allowed_models if model_id in id_set]

    if not model_ids:
        console.print("[bold red]No models available for the selected platform[/bold red]")
        return None

    model_id = await _prompt_choice(
        header="Select the model",
        choices=model_ids,
    )
    if not model_id:
        console.print("[bold red]No model selected[/bold red]")
        return None

    return _SetupResult(
        platform_kind=platform_kind,
        base_url=platform.base_url,
        api_key=SecretStr(api_key),
        model_id=model_id,
        max_context_size=200_000,  # TODO: get from model
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
    session = PromptSession()
    try:
        return str(
            await session.prompt_async(
                f" {prompt}: ",
                is_password=is_password,
            )
        ).strip()
    except (EOFError, KeyboardInterrupt):
        return None


@meta_command
def reload(app: "ShellApp", args: list[str]):
    """Reload configuration."""
    from kimi_cli import Reload

    raise Reload

import asyncio
import tempfile
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

import aiohttp
from pydantic import SecretStr

from kimi_cli.config import LLMModel, LLMProvider, load_config, save_config
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
        name="Kimi Coding",
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
    save_config(config)
    console.print("[bold green]✓[/bold green] Kimi CLI has been setup! Restarting...")
    await asyncio.sleep(1)
    console.clear()

    from kimi_cli import Restart

    raise Restart


class _SetupResult(NamedTuple):
    platform_kind: _PlatformKind
    base_url: str
    api_key: SecretStr
    model_id: str
    max_context_size: int


async def _setup() -> _SetupResult | None:
    output_filepath = Path(tempfile.mktemp())
    try:
        # select the API platform
        output_filepath.write_text("")
        platform_choices = " ".join(f"'{platform.name}'" for platform in _PLATFORMS.values())
        result = await asyncio.create_subprocess_shell(
            (
                f"gum choose --header 'Select the API platform' {platform_choices} "
                f"| tee {output_filepath}"
            ),
        )
        await result.wait()
        platform_name = Path(output_filepath).read_text().strip()
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
        api_key = SecretStr("")
        while not api_key:
            output_filepath.write_text("")
            result = await asyncio.create_subprocess_shell(
                f"gum input --header 'Enter your API key' | tee {output_filepath}",
            )
            await result.wait()
            api_key = SecretStr(Path(output_filepath).read_text().strip())
            if not api_key:
                console.print("[bold red]No API key entered[/bold red]")
                return None

        # list models
        models_url = f"{platform.base_url}/models"
        try:
            async with (
                aiohttp.ClientSession() as session,
                session.get(
                    models_url,
                    headers={
                        "Authorization": f"Bearer {api_key.get_secret_value()}",
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
        model_choices = " ".join(f"'{model_id}'" for model_id in model_ids)
        output_filepath.write_text("")
        result = await asyncio.create_subprocess_shell(
            f"gum choose --header 'Select the model' {model_choices} | tee {output_filepath}",
        )
        await result.wait()
        model_id = Path(output_filepath).read_text().strip()
        if not model_id:
            console.print("[bold red]No model selected[/bold red]")
            return None

        return _SetupResult(
            platform_kind=platform_kind,
            base_url=platform.base_url,
            api_key=api_key,
            model_id=model_id,
            max_context_size=200_000,  # TODO: get from model
        )
    finally:
        output_filepath.unlink(missing_ok=True)

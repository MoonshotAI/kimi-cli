import asyncio
from typing import TYPE_CHECKING, NamedTuple

import aiohttp
from prompt_toolkit import PromptSession
from prompt_toolkit.shortcuts.choice_input import ChoiceInput
from pydantic import SecretStr
from kimi_cli.config import LLMModel, LLMProvider, load_config, save_config
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.metacmd import meta_command
from kimi_cli.utils.aiohttp import new_client_session

if TYPE_CHECKING:
    from kimi_cli.ui.shell import ShellApp


@meta_command
async def setup(app: "ShellApp", args: list[str]):
    """Setup Kimi CLI"""
    result = await _setup()
    if not result:
        # error message already printed
        return
    config = load_config()
    provider_name = "openai"
    config.providers[provider_name] = LLMProvider(
        type="openai",
        base_url=result.base_url,
        api_key=result.api_key,
    )
    config.models[result.model_id] = LLMModel(
        provider=provider_name,
        model=result.model_id,
        max_context_size=result.max_context_size,
    )
    config.default_model = result.model_id
    save_config(config)
    console.print("[green]✓[/green] Kimi CLI has been setup! Reloading...")
    await asyncio.sleep(1)
    console.clear()

    from kimi_cli.cli import Reload

    raise Reload


class _SetupResult(NamedTuple):
    base_url: str
    api_key: SecretStr
    model_id: str
    max_context_size: int


async def _setup() -> _SetupResult | None:
    base_url = await _prompt_text("Enter the API base URL")
    if not base_url:
        return None
    api_key = await _prompt_text("Enter your API key", is_password=True)
    if not api_key:
        return None
    # list models
    models_url = f"{base_url}/models"
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
    model_ids = [model["id"] for model in resp_json["data"]]
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
        base_url=base_url,
        api_key=SecretStr(api_key),
        model_id=model_id,
        max_context_size=model.get("context_length", 8192),
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
    """Reload configuration"""
    from kimi_cli.cli import Reload
    raise Reload
@meta_command
async def model(app: "ShellApp", args: list[str]):
    """Switch between models"""
    config = load_config()
    if not config.models:
        console.print("[red]No models configured. Run /setup first.[/red]")
        return
    model_name = await _prompt_choice(
        header="Select a model",
        choices=list(config.models.keys()),
    )
    if not model_name:
        console.print("[red]No model selected.[/red]")
        return
    config.default_model = model_name
    save_config(config)
    console.print(
        f"[green]✓[/green] Switched to model [bold]{model_name}[/bold]. Reloading..."
    )
    await asyncio.sleep(1)
    console.clear()
    from kimi_cli.cli import Reload
    raise Reload

from __future__ import annotations

from typing import TYPE_CHECKING

from prompt_toolkit.shortcuts.choice_input import ChoiceInput

from kimi_cli.config import load_config
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.metacmd import meta_command

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell


@meta_command
async def model(app: Shell, args: list[str]):
    config = load_config()
    if not config.models:
        console.print("[yellow]No models configured. Run /setup first.[/yellow]")
        return

    current_model = app.soul.model_name if isinstance(app.soul, KimiSoul) else ""

    options: list[tuple[str, str]] = []
    for model_id in sorted(config.models.keys()):
        label = f"{model_id}"
        if model_id == current_model:
            label += " (current)"
        elif model_id == config.default_model:
            label += " (default)"
        options.append((model_id, label))

    default_choice = current_model or config.default_model or options[0][0]
    try:
        selection = await ChoiceInput(
            message="Select the model (↑↓ navigate, Enter select, Ctrl+C cancel):",
            options=options,
            default=default_choice,
        ).prompt_async()
    except (EOFError, KeyboardInterrupt):
        return

    if not selection:
        return

    model_config = config.models.get(selection)
    if model_config is None:
        console.print(f"[red]Model {selection} not found in config.[/red]")
        return

    provider_config = config.providers.get(model_config.provider)
    if provider_config is None:
        console.print(f"[red]Provider {model_config.provider} not found in config.[/red]")
        return

    provider_for_runtime = provider_config.model_copy(deep=True)
    model_for_runtime = model_config.model_copy(deep=True)

    try:
        assert isinstance(app.soul, KimiSoul)
        app.soul.switch_model(provider_for_runtime, model_for_runtime)
    except Exception as e:
        console.print(f"[red]Failed to switch model: {e}[/red]")
        return

    console.print(f"[green]✓[/green] Model switched to {selection}")

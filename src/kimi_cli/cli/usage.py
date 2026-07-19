from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Annotated, Any, NoReturn, cast

import aiohttp
import typer

from kimi_cli.config import Config, LLMModel, LLMProvider
from kimi_cli.exception import ConfigError

cli = typer.Typer(help="Display Kimi Code quota usage.")


def _exit_error(message: str) -> NoReturn:
    typer.echo(f"Error: {message}", err=True)
    raise typer.Exit(code=1)


def _load_config_from_root_options(ctx: typer.Context) -> Config:
    from kimi_cli.config import load_config, load_config_from_string

    root_params = ctx.find_root().params
    config_string = cast(str | None, root_params.get("config_string"))
    config_file_raw = root_params.get("config_file")
    config_file = Path(config_file_raw) if config_file_raw is not None else None

    if config_string is not None and config_file is not None:
        raise typer.BadParameter(
            "Cannot combine --config, --config-file.",
            param_hint="--config",
        )

    if config_string is not None:
        config_string = config_string.strip()
        if not config_string:
            raise typer.BadParameter("Config cannot be empty", param_hint="--config")
        try:
            return load_config_from_string(config_string)
        except ConfigError as exc:
            raise typer.BadParameter(str(exc), param_hint="--config") from exc

    try:
        return load_config(config_file)
    except ConfigError as exc:
        param_hint = "--config-file" if config_file is not None else None
        raise typer.BadParameter(str(exc), param_hint=param_hint) from exc


def _select_usage_target(config: Config, *, model_name: str | None) -> tuple[LLMModel, LLMProvider]:
    selected_model = model_name or config.default_model
    if not selected_model:
        _exit_error("No model configured. Run `kimi login` or pass --model.")

    model = config.models.get(selected_model)
    if model is None:
        _exit_error(f"Model '{selected_model}' not found in configuration.")

    provider = config.providers.get(model.provider)
    if provider is None:
        _exit_error(f"Provider '{model.provider}' not found in configuration.")

    return model, provider


def _format_usage_fetch_error(exc: aiohttp.ClientResponseError) -> str:
    if exc.status == 401:
        return "Authorization failed. Please check your API key."
    if exc.status == 404:
        return "Usage endpoint not available. Try Kimi for Coding."
    return "Failed to fetch usage."


async def _fetch_usage_payload(ctx: typer.Context) -> dict[str, Any]:
    from kimi_cli.auth.oauth import OAuthError, OAuthManager
    from kimi_cli.llm import augment_provider_with_env_vars
    from kimi_cli.ui.shell import usage as shell_usage

    config = _load_config_from_root_options(ctx)
    model_name = cast(str | None, ctx.find_root().params.get("model_name"))
    model, provider = _select_usage_target(config, model_name=model_name)

    augment_provider_with_env_vars(provider, model)
    usage_url = shell_usage.get_usage_url(model)
    if usage_url is None:
        _exit_error("Usage is available on Kimi Code platform only.")

    oauth = OAuthManager(config)
    if provider.oauth is not None:
        try:
            await oauth.ensure_fresh()
        except OAuthError as exc:
            if not provider.api_key.get_secret_value():
                _exit_error(f"Failed to refresh OAuth token: {exc}")
            typer.echo(f"Warning: failed to refresh OAuth token: {exc}", err=True)

    api_key = oauth.resolve_api_key(provider.api_key, provider.oauth)
    try:
        return dict(await shell_usage.fetch_usage(usage_url, api_key))
    except aiohttp.ClientResponseError as exc:
        _exit_error(_format_usage_fetch_error(exc))
    except TimeoutError:
        _exit_error("Failed to fetch usage: request timed out.")
    except aiohttp.ClientError as exc:
        _exit_error(f"Failed to fetch usage: {exc}")


def _emit_usage(payload: dict[str, Any], *, json_output: bool) -> None:
    from kimi_cli.ui.shell import usage as shell_usage
    from kimi_cli.ui.shell.console import console

    if json_output:
        typer.echo(json.dumps(payload, ensure_ascii=False))
        return

    summary, limits = shell_usage.parse_usage_payload(payload)
    if summary is None and not limits:
        console.print("[yellow]No usage data available.[/yellow]")
        return

    console.print(shell_usage.build_usage_panel(summary, limits))


@cli.callback(invoke_without_command=True)
def usage(
    ctx: typer.Context,
    json_output: Annotated[
        bool,
        typer.Option(
            "--json",
            help="Output the raw usage API response as JSON.",
        ),
    ] = False,
):
    """Display Kimi Code quota usage."""
    payload = asyncio.run(_fetch_usage_payload(ctx))
    _emit_usage(payload, json_output=json_output)

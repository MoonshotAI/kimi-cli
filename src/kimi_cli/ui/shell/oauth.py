from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import TYPE_CHECKING

from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyPressEvent
from rich.panel import Panel
from rich.status import Status
from rich.text import Text

from kimi_cli.auth import KIMI_CODE_PLATFORM_ID
from kimi_cli.auth.oauth import login_kimi_code, logout_kimi_code
from kimi_cli.auth.platforms import is_managed_provider_key, parse_managed_provider_key
from kimi_cli.cli import Reload
from kimi_cli.config import save_config
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.console import console, render_to_ansi
from kimi_cli.ui.shell.setup import select_platform, setup_platform
from kimi_cli.ui.shell.slash import ensure_kimi_soul, registry

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell


class _OAuthLoginPromptDelegate:
    modal_priority = 5

    def __init__(self, cancel_event: asyncio.Event) -> None:
        self._cancel_event = cancel_event

    def render_running_prompt_body(self, columns: int) -> ANSI:
        panel = Panel(
            Text("Waiting for browser authorization. Press Esc or Ctrl+C to cancel.", style="dim"),
            title="[bold]login[/bold]",
            title_align="left",
            border_style="cyan",
            padding=(0, 1),
        )
        return ANSI(render_to_ansi(panel, columns=columns).rstrip("\n"))

    def running_prompt_placeholder(self) -> None:
        return None

    def running_prompt_allows_text_input(self) -> bool:
        return False

    def running_prompt_hides_input_buffer(self) -> bool:
        return True

    def running_prompt_accepts_submission(self) -> bool:
        return False

    def should_handle_running_prompt_key(self, key: str) -> bool:
        return key in {"escape", "c-c", "c-d"}

    def handle_running_prompt_key(self, key: str, event: KeyPressEvent) -> None:
        self._cancel_event.set()


async def _watch_login_cancel(prompt_session: object, cancel_event: asyncio.Event) -> None:
    while not cancel_event.is_set():
        try:
            await prompt_session.prompt_next()  # pyright: ignore[reportAttributeAccessIssue]
        except (KeyboardInterrupt, EOFError):
            cancel_event.set()
            return


async def _login_kimi_code(app: Shell, soul: KimiSoul) -> bool:
    status: Status | None = None
    cancel_event = asyncio.Event()
    prompt_task: asyncio.Task[None] | None = None
    prompt_session = app._prompt_session  # pyright: ignore[reportPrivateUsage]
    modal = None
    ok = True
    try:
        if prompt_session is not None:
            modal = _OAuthLoginPromptDelegate(cancel_event)
            prompt_session.attach_modal(modal)
            prompt_task = asyncio.create_task(_watch_login_cancel(prompt_session, cancel_event))

        async for event in login_kimi_code(soul.runtime.config, cancel_event=cancel_event):
            if event.type == "waiting":
                if status is None:
                    status = console.status("[cyan]Waiting for user authorization...[/cyan]")
                    status.start()
                continue
            if status is not None:
                status.stop()
                status = None
            match event.type:
                case "error":
                    style = "red"
                case "success":
                    style = "green"
                case _:
                    style = None
            console.print(event.message, markup=False, style=style)
            if event.type == "error":
                ok = False
    finally:
        if prompt_task is not None:
            prompt_task.cancel()
            with suppress(asyncio.CancelledError):
                await prompt_task
        if prompt_session is not None and modal is not None:
            prompt_session.detach_modal(modal)
        if status is not None:
            status.stop()
    return ok


def current_model_key(soul: KimiSoul) -> str | None:
    config = soul.runtime.config
    curr_model_cfg = soul.runtime.llm.model_config if soul.runtime.llm else None
    if curr_model_cfg is not None:
        for name, model_cfg in config.models.items():
            if model_cfg == curr_model_cfg:
                return name
    return config.default_model or None


@registry.command(aliases=["setup"])
async def login(app: Shell, args: str) -> None:
    """Login or setup a platform."""
    soul = ensure_kimi_soul(app)
    if soul is None:
        return
    platform = await select_platform()
    if platform is None:
        return
    if platform.id == KIMI_CODE_PLATFORM_ID:
        ok = await _login_kimi_code(app, soul)
    else:
        ok = await setup_platform(platform)
    if not ok:
        return
    from kimi_cli.telemetry import track

    track("login", provider=platform.id)
    await asyncio.sleep(1)
    console.clear()
    raise Reload


@registry.command
async def logout(app: Shell, args: str) -> None:
    """Logout from the current platform."""
    soul = ensure_kimi_soul(app)
    if soul is None:
        return
    config = soul.runtime.config
    if not config.is_from_default_location:
        console.print(
            "[red]Logout requires the default config file; "
            "restart without --config/--config-file.[/red]"
        )
        return
    model_key = current_model_key(soul)
    if not model_key:
        console.print("[yellow]No model selected; nothing to logout.[/yellow]")
        return
    model_cfg = config.models.get(model_key)
    if model_cfg is None:
        console.print("[yellow]Current model not found; nothing to logout.[/yellow]")
        return
    provider_key = model_cfg.provider
    if not is_managed_provider_key(provider_key):
        console.print("[yellow]Current provider is not managed; nothing to logout.[/yellow]")
        return
    platform_id = parse_managed_provider_key(provider_key)
    if not platform_id:
        console.print("[yellow]Current provider is not managed; nothing to logout.[/yellow]")
        return

    if platform_id == KIMI_CODE_PLATFORM_ID:
        ok = True
        async for event in logout_kimi_code(config):
            match event.type:
                case "error":
                    style = "red"
                case "success":
                    style = "green"
                case _:
                    style = None
            console.print(event.message, markup=False, style=style)
            if event.type == "error":
                ok = False
        if not ok:
            return
    else:
        if provider_key in config.providers:
            del config.providers[provider_key]
        removed_default = False
        for key, model in list(config.models.items()):
            if model.provider != provider_key:
                continue
            del config.models[key]
            if config.default_model == key:
                removed_default = True
        if removed_default:
            config.default_model = ""
        save_config(config)
        console.print("[green]✓[/green] Logged out successfully.")

    from kimi_cli.telemetry import track

    track("logout")
    await asyncio.sleep(1)
    console.clear()
    raise Reload

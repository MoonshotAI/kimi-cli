from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from rich.status import Status

from kimi_cli.auth.oauth import login_kimi_code, logout_kimi_code
from kimi_cli.cli import Reload
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.slash import registry

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell


def _ensure_kimi_soul(app: Shell) -> KimiSoul | None:
    if not isinstance(app.soul, KimiSoul):
        console.print("[red]KimiSoul required[/red]")
        return None
    return app.soul


@registry.command
async def login(app: Shell, args: str) -> None:
    """Login to your Kimi account."""
    soul = _ensure_kimi_soul(app)
    if soul is None:
        return
    status: Status | None = None
    ok = True
    try:
        async for event in login_kimi_code(soul.runtime.config):
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
        if status is not None:
            status.stop()
    if not ok:
        return

    await asyncio.sleep(1)
    console.clear()
    raise Reload


@registry.command
async def logout(app: Shell, args: str) -> None:
    """Logout from your Kimi account."""
    soul = _ensure_kimi_soul(app)
    if soul is None:
        return
    ok = True
    async for event in logout_kimi_code(soul.runtime.config):
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
    await asyncio.sleep(1)
    console.clear()
    raise Reload

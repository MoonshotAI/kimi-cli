"""
Example: Run Kimi CLI on top of an E2B sandbox.

Docs:
- E2B user/workdir defaults: https://e2b.dev/docs/template/user-and-workdir
- E2B commands/filesystem: https://e2b.dev/docs/commands / https://e2b.dev/docs/filesystem
- E2B API keys: https://e2b.dev/dashboard?tab=keys
"""

import asyncio
import os
from pathlib import Path

from e2b import AsyncSandbox
from kaos import reset_current_kaos, set_current_kaos
from kaos.contrib.e2b import E2BKaos
from kaos.path import KaosPath
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table
from rich.text import Text

from kimi_cli.app import KimiCLI, enable_logging
from kimi_cli.session import Session
from kimi_cli.ui.shell import Shell


async def main() -> None:
    enable_logging()
    console = Console()
    _render_banner(console)
    _render_key_status(console)

    work_dir_path = os.getenv("KIMI_WORK_DIR", DEFAULT_WORK_DIR)
    sandbox: AsyncSandbox = await _select_sandbox(console)
    console.print(f"[green]using sandbox:[/green] {sandbox.sandbox_id}")
    e2b_kaos = E2BKaos(
        sandbox,
        cwd=work_dir_path,
    )

    token = set_current_kaos(e2b_kaos)
    try:
        work_dir = KaosPath(work_dir_path)
        await work_dir.mkdir(parents=True, exist_ok=True)

        session: Session = await Session.create(work_dir)
        instance: KimiCLI = await KimiCLI.create(session, yolo=True, agent_file=AGENT_FILE)
        ui = Shell(instance.soul)
        await ui.run()
    finally:
        reset_current_kaos(token)


async def _select_sandbox(console: Console) -> AsyncSandbox:
    mode = _prompt_choice(console)
    if mode == "create":
        sandbox: AsyncSandbox = await AsyncSandbox.create(
            template=DEFAULT_TEMPLATE,
            timeout=DEFAULT_TIMEOUT_SEC,
        )
        return sandbox

    sandbox_id = os.getenv("E2B_SANDBOX_ID")
    if not sandbox_id:
        sandbox_id = _prompt_text(console, "Sandbox ID", "Enter an existing E2B sandbox ID")
        if not sandbox_id:
            raise RuntimeError("Sandbox ID is required for connect mode")
    sandbox = await AsyncSandbox.connect(sandbox_id)
    return sandbox


def _prompt_choice(console: Console) -> str:
    default_mode = "connect" if os.getenv("E2B_SANDBOX_ID") else "create"
    options = [
        ("1", "create", "Create a new sandbox"),
        ("2", "connect", "Connect to existing sandbox"),
    ]
    table = Table(title="Sandbox mode")
    table.add_column("Key", style="cyan")
    table.add_column("Action")
    for key, _, label in options:
        table.add_row(key, label)
    console.print(table)
    choice = Prompt.ask(
        "Select option",
        choices=[item[0] for item in options],
        default="1" if default_mode == "create" else "2",
        console=console,
    )
    for key, value, _ in options:
        if choice == key:
            return value
    return default_mode


def _prompt_text(console: Console, title: str, text: str) -> str:
    console.print(f"[dim]{text}[/dim]")
    return Prompt.ask(title, default="", console=console).strip()


def _render_banner(console: Console) -> None:
    title = Text("Kimi CLI + E2B KAOS", style="bold cyan")
    subtitle = Text("interactive sandbox selector", style="dim")
    console.print(Panel.fit(Text.assemble(title, "\n", subtitle)))


def _render_key_status(console: Console) -> None:
    api_key = os.getenv("E2B_API_KEY", "")
    if api_key:
        masked = f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) > 8 else "set"
        console.print(f"[green]E2B_API_KEY:[/green] {masked}")
        return

    message = Text.assemble(
        ("E2B_API_KEY not set. Configure it at: ", "yellow"),
        ("https://e2b.dev/dashboard?tab=keys", "bold"),
    )
    console.print(Panel.fit(message, title="Missing API Key", border_style="yellow"))


DEFAULT_WORK_DIR = "/home/user/kimi-workdir"
DEFAULT_TEMPLATE = "base"
DEFAULT_TIMEOUT_SEC = 300
AGENT_FILE = Path(__file__).resolve().with_name("agent.yaml")


if __name__ == "__main__":
    asyncio.run(main())

from __future__ import annotations

import asyncio
import json
import os
import webbrowser
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web

from gitrekt_cli.share import get_share_dir
from gitrekt_cli.utils.logging import logger

GITREKT_TOKEN_FILE = "session_token"
GITREKT_CONFIG_FILE = "gitrekt_config.json"


class AuthServer:
    def __init__(self, port: int = 3123):
        self.port = port
        self.token: str | None = None
        self._runner: web.AppRunner | None = None

    async def handle_callback(self, request: web.Request) -> web.Response:
        """Handle the OAuth callback and extract the session token."""
        self.token = request.query.get("token")
        if not self.token:
            return web.Response(text="Authentication failed: No token received.", status=400)
        logger.info("Successfully received session token")
        return web.Response(text="Authentication successful! You can close this window.")

    async def start(self) -> None:
        """Start the local callback server."""
        app = web.Application()
        app.router.add_get("/callback", self.handle_callback)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "localhost", self.port)
        await site.start()
        logger.debug(f"Auth callback server started at http://localhost:{self.port}/callback")

    async def stop(self) -> None:
        """Stop the local callback server."""
        if self._runner:
            await self._runner.cleanup()


def show_login_prompt() -> None:
    """Show a prompt asking the user to login."""
    from rich.console import Console
    from rich.text import Text

    console = Console()

    # Simple prompt without the full welcome panel to avoid duplication
    text = Text()
    text.append("Authentication required. ", style="bold cyan")
    text.append("Press ", style="grey50")
    text.append("Enter", style="bold green")
    text.append(" to open the browser and login with GitHub, or ", style="grey50")
    text.append("Ctrl+C", style="bold yellow")
    text.append(" to cancel.", style="grey50")

    console.print(text)


async def login_flow(timeout_seconds: int = 60) -> str | None:
    """
    Initiate the browser-based login flow and wait for the OAuth callback.

    Args:
        timeout_seconds: Maximum time to wait for authentication (default: 60).

    Returns:
        The session token if authentication succeeds, None otherwise.
    """
    gitrekt_url = os.getenv("GITREKT_URL", "http://localhost:3000")
    callback_port = 3123
    auth_server = AuthServer(port=callback_port)
    await auth_server.start()

    login_url = f"{gitrekt_url}/?callback_url=http://localhost:{callback_port}/callback"
    logger.info(f"Opening browser for authentication: {login_url}")
    webbrowser.open(login_url)

    try:
        start_time = asyncio.get_event_loop().time()
        while not auth_server.token:
            if asyncio.get_event_loop().time() - start_time > timeout_seconds:
                break
            await asyncio.sleep(0.5)
    finally:
        await auth_server.stop()

    return auth_server.token


def get_token_file() -> Path:
    """Get the path to the session token file."""
    return get_share_dir() / GITREKT_TOKEN_FILE


def get_config_file() -> Path:
    """Get the path to the Gitrekt config file."""
    return get_share_dir() / GITREKT_CONFIG_FILE


def save_token(token: str) -> None:
    """Save the session token to the local file."""
    token_file = get_token_file()
    token_file.write_text(token)
    logger.info(f"Session token saved to {token_file}")


def load_token() -> str | None:
    """Load the session token from the local file."""
    token_file = get_token_file()
    if not token_file.exists():
        return None
    return token_file.read_text().strip()


async def fetch_gitrekt_config(token: str) -> dict[str, Any] | None:
    """Fetch the CLI configuration from the Gitrekt server using the session token."""
    gitrekt_url = os.getenv("GITREKT_URL", "http://localhost:3000")
    config_url = f"{gitrekt_url}/api/cli/config"

    try:
        async with aiohttp.ClientSession() as session:
            headers = {"Authorization": f"Bearer {token}"}
            async with session.get(config_url, headers=headers) as response:
                if response.status == 200:
                    return await response.json()
                logger.warning(f"Failed to fetch config from Gitrekt: {response.status}")
                return None
    except Exception as e:
        logger.warning(f"Failed to fetch config from Gitrekt: {e}")
        return None


def save_gitrekt_config(config: dict[str, Any]) -> None:
    """Save the Gitrekt-provided configuration to the local config file."""
    config_file = get_config_file()
    config_file.write_text(json.dumps(config, indent=2))
    logger.info(f"Gitrekt config saved to {config_file}")


def load_gitrekt_config() -> dict[str, Any] | None:
    """Load the Gitrekt-provided configuration from the local cache."""
    config_file = get_config_file()
    if not config_file.exists():
        return None
    try:
        return json.loads(config_file.read_text())
    except json.JSONDecodeError:
        return None


def clear_auth_files() -> bool:
    """
    Clear authentication files (token and config).

    Returns:
        True if any files were removed, False otherwise.
    """
    token_file = get_token_file()
    config_file = get_config_file()

    removed = False
    if token_file.exists():
        token_file.unlink()
        removed = True
    if config_file.exists():
        config_file.unlink()
        removed = True

    return removed

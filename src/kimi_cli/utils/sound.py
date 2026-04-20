"""Cross-platform sound notification utilities.

Plays short audio cues fire-and-forget using platform-native players.
Supports normal Python runs and PyInstaller-frozen bundles.
"""

from __future__ import annotations

import asyncio
import shutil
import sys
import threading
from contextlib import suppress
from pathlib import Path
from typing import cast

from kimi_cli.utils.logging import logger
from kimi_cli.utils.subprocess_env import get_clean_env

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    meipass = cast(str, sys._MEIPASS)  # pyright: ignore[reportUnknownMemberType,reportAttributeAccessIssue]
    _sounds_dir = Path(meipass) / "kimi_cli" / "assets" / "sounds"
else:
    _sounds_dir = Path(__file__).parent.parent / "assets" / "sounds"

DONE_SOUND = _sounds_dir / "done_sound.wav"
PERMISSION_SOUND = _sounds_dir / "permission_sound.wav"

# Strong references for fire-and-forget asyncio tasks (Python 3.12+ weak-ref semantics).
_pending_tasks: set[asyncio.Task[None]] = set()


def _get_player_cmd(path: Path) -> list[str] | None:
    """Return a platform-specific command to play *path*, or None if unsupported."""
    if sys.platform == "darwin":
        if shutil.which("afplay"):
            return ["afplay", str(path)]
    elif sys.platform == "win32":
        # Escape single quotes for PowerShell single-quoted strings by doubling them.
        ps_path = str(path).replace("'", "''")
        return [
            "powershell.exe",
            "-NoProfile",
            "-Command",
            f"(New-Object Media.SoundPlayer '{ps_path}').PlaySync()",
        ]
    else:
        for binary in ("paplay", "aplay", "ffplay"):
            if shutil.which(binary):
                if binary == "ffplay":
                    return [binary, "-nodisp", "-autoexit", "-loglevel", "quiet", str(path)]
                return [binary, str(path)]
    return None


def play_sound(path: Path) -> None:
    """Fire-and-forget a background sound if *path* exists and a player is available."""
    if not path.exists():
        return

    cmd = _get_player_cmd(path)
    if cmd is None:
        logger.debug("No sound player found for platform {}", sys.platform)
        return

    async def _play() -> None:
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                env=get_clean_env(),
            )
            await proc.wait()
        except Exception:
            logger.debug("Failed to play sound {}", path)

    try:
        task = asyncio.get_running_loop().create_task(_play())
        _pending_tasks.add(task)
        task.add_done_callback(_pending_tasks.discard)
    except RuntimeError:
        # No running event loop — run a quick blocking subprocess in a daemon thread.
        import subprocess

        def _thread() -> None:
            with suppress(Exception):
                subprocess.run(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    env=get_clean_env(),
                )

        threading.Thread(target=_thread, daemon=True).start()


def play_done_sound() -> None:
    """Play the sound indicating the agent has finished a turn."""
    play_sound(DONE_SOUND)


def play_permission_sound() -> None:
    """Play the sound indicating the agent needs user permission."""
    play_sound(PERMISSION_SOUND)

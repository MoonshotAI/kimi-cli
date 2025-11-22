from __future__ import annotations

import json
import shutil
from pathlib import Path

import aiofiles

from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.shell.console import console
from kimi_cli.utils.logging import logger


class SessionManager:
    """Manages saved sessions for the Kimi CLI."""

    def __init__(self, share_dir: Path):
        self.saved_sessions_dir = share_dir / "saved_sessions"
        self.saved_sessions_dir.mkdir(parents=True, exist_ok=True)

    def get_session_path(self, session_id: str) -> Path:
        """Get the path for a saved session."""
        return self.saved_sessions_dir / f"{session_id}.jsonl"

    def get_session_metadata_path(self, session_id: str) -> Path:
        """Get the metadata path for a saved session."""
        return self.saved_sessions_dir / f"{session_id}_metadata.json"

    def list_saved_sessions(self) -> list[str]:
        """List all saved session IDs."""
        sessions = []
        for file in self.saved_sessions_dir.glob("*.jsonl"):
            if not file.name.endswith("_metadata.json"):
                session_id = file.stem
                sessions.append(session_id)
        return sorted(sessions)

    async def save_session(
        self, session_id: str, context: Context, soul: KimiSoul, force: bool = False
    ) -> bool:
        """Save the current session with the given ID."""
        try:
            # Validate session ID
            if not session_id or not session_id.replace("-", "").replace("_", "").isalnum():
                console.print(
                    "[red]Invalid session ID. Use only alphanumeric characters, "
                    "hyphens, and underscores.[/red]"
                )
                return False

            session_path = self.get_session_path(session_id)
            metadata_path = self.get_session_metadata_path(session_id)

            # Check if session already exists
            if session_path.exists() and not force:
                console.print(
                    f"[yellow]Session '{session_id}' already exists. Overwrite? (y/N)[/yellow]"
                )
                response = input().strip().lower()
                if response != "y":
                    console.print("[yellow]Save cancelled.[/yellow]")
                    return False

            # Copy current context file to saved session
            if not context._file_backend.exists():
                console.print("[red]No session history to save.[/red]")
                return False

            # Copy the context file
            shutil.copy2(context._file_backend, session_path)

            # Save session metadata
            metadata = {
                "session_id": session_id,
                "saved_at": context._file_backend.stat().st_mtime,
                "message_count": len(context.history),
                "token_count": context.token_count,
                "checkpoint_count": context.n_checkpoints,
                "soul_config": {
                    "thinking": soul.thinking,
                    "agent_name": soul.name,
                },
            }

            async with aiofiles.open(metadata_path, "w", encoding="utf-8") as f:
                await f.write(json.dumps(metadata, indent=2))

            console.print(f"[green]✓[/green] Session saved as: {session_id}")
            console.print(
                f"  Messages: {len(context.history)}, Tokens: {context.token_count}, "
                f"Checkpoints: {context.n_checkpoints}"
            )
            return True

        except Exception as e:
            logger.exception(f"Failed to save session '{session_id}':")
            console.print(f"[red]Failed to save session: {e}[/red]")
            return False

    async def load_session(
        self, session_id: str, context: Context, soul: KimiSoul, force: bool = False
    ) -> bool:
        """Load a saved session with the given ID."""
        try:
            session_path = self.get_session_path(session_id)
            metadata_path = self.get_session_metadata_path(session_id)

            # Check if session exists
            if not session_path.exists():
                available_sessions = self.list_saved_sessions()
                if available_sessions:
                    console.print(f"[red]Session '{session_id}' not found.[/red]")
                    console.print("Available sessions:")
                    for session in available_sessions:
                        console.print(f"  • {session}")
                else:
                    console.print("[red]No saved sessions found.[/red]")
                return False

            # Load metadata
            saved_metadata = {}
            if metadata_path.exists():
                import aiofiles

                async with aiofiles.open(metadata_path, encoding="utf-8") as f:
                    content = await f.read()
                    saved_metadata = json.loads(content)

            # Confirm loading
            if not force:
                message_count = saved_metadata.get("message_count", "unknown")
                token_count = saved_metadata.get("token_count", "unknown")
                saved_at = saved_metadata.get("saved_at", "unknown")

                console.print(f"[yellow]Load session '{session_id}'?[/yellow]")
                console.print(f"  Messages: {message_count}, Tokens: {token_count}")
                if saved_at != "unknown":
                    import datetime

                    saved_date = datetime.datetime.fromtimestamp(saved_at).strftime(
                        "%Y-%m-%d %H:%M:%S"
                    )
                    console.print(f"  Saved: {saved_date}")

                response = input("Proceed? (y/N): ").strip().lower()
                if response != "y":
                    console.print("[yellow]Load cancelled.[/yellow]")
                    return False

            # Backup current context
            if context._file_backend.exists():
                from kimi_cli.utils.path import next_available_rotation

                backup_path = await next_available_rotation(context._file_backend)
                if backup_path:
                    import aiofiles.os

                    await aiofiles.os.rename(context._file_backend, backup_path)
                    logger.debug(f"Backed up current context to: {backup_path}")

            # Copy saved session to current context
            import shutil

            shutil.copy2(session_path, context._file_backend)

            # Reload context from the restored file
            context._history.clear()
            context._token_count = 0
            context._next_checkpoint_id = 0

            # Restore the context
            await context.restore()

            # Apply saved soul configuration if available
            if "soul_config" in saved_metadata:
                soul_config = saved_metadata["soul_config"]
                if "thinking" in soul_config:
                    soul.set_thinking(soul_config["thinking"])

            console.print(f"[green]✓[/green] Session loaded: {session_id}")
            console.print(
                f"  Restored {len(context.history)} messages, {context.token_count} tokens"
            )
            return True

        except Exception as e:
            logger.exception(f"Failed to load session '{session_id}':")
            console.print(f"[red]Failed to load session: {e}[/red]")
            return False


# Global session manager instance
_session_manager: SessionManager | None = None


def get_session_manager() -> SessionManager:
    """Get the global session manager instance."""
    global _session_manager
    if _session_manager is None:
        from kimi_cli.share import get_share_dir

        _session_manager = SessionManager(get_share_dir())
    return _session_manager

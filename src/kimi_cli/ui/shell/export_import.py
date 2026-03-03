from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

import aiofiles
from kosong.message import Message

from kimi_cli.session import Session
from kimi_cli.soul.context import Context
from kimi_cli.soul.message import system
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.slash import ensure_kimi_soul, registry, shell_mode_registry
from kimi_cli.utils.export import (
    build_export_markdown,
    is_importable_file,
    stringify_context_history,
)
from kimi_cli.utils.path import sanitize_cli_path
from kimi_cli.wire.types import TextPart, TurnBegin, TurnEnd

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell


# ---------------------------------------------------------------------------
# /export command
# ---------------------------------------------------------------------------


@registry.command
@shell_mode_registry.command
async def export(app: Shell, args: str):
    """Export current session context to a markdown file"""
    soul = ensure_kimi_soul(app)
    if soul is None:
        return

    context = soul.context
    history = list(context.history)  # snapshot to avoid concurrent mutation

    if not history:
        console.print("[yellow]No messages to export.[/yellow]")
        return

    session = soul.runtime.session

    # Determine output path
    now = datetime.now()
    short_id = session.id[:8]
    default_name = f"kimi-export-{short_id}-{now.strftime('%Y%m%d-%H%M%S')}.md"

    cleaned = sanitize_cli_path(args)
    if cleaned:
        output = Path(cleaned).expanduser()
        if output.is_dir():
            output = output / default_name
    else:
        output = Path.cwd() / default_name

    # Build and write markdown
    content = build_export_markdown(
        session_id=session.id,
        work_dir=str(session.work_dir),
        history=history,
        token_count=context.token_count,
        now=now,
    )

    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        async with aiofiles.open(output, "w", encoding="utf-8") as f:
            await f.write(content)
    except OSError as e:
        console.print(f"[red]Failed to write export file: {e}[/red]")
        return

    console.print(f"[green]Exported {len(history)} messages to {output}[/green]")
    console.print(
        "[yellow]Note: The exported file may contain sensitive information. "
        "Please be cautious when sharing it externally.[/yellow]"
    )


# ---------------------------------------------------------------------------
# /import command
# ---------------------------------------------------------------------------


@registry.command(name="import")
@shell_mode_registry.command(name="import")
async def import_context(app: Shell, args: str):
    """Import context from a file or session ID"""
    soul = ensure_kimi_soul(app)
    if soul is None:
        return

    target = sanitize_cli_path(args)
    if not target:
        console.print("[yellow]Usage: /import <file_path or session_id>[/yellow]")
        return

    target_path = Path(target).expanduser()

    if target_path.exists() and target_path.is_dir():
        console.print(
            "[red]The specified path is a directory; please provide a file to import.[/red]"
        )
        return
    elif target_path.exists() and target_path.is_file():
        # Check file extension
        if not is_importable_file(target_path.name):
            console.print(
                f"[red]Unsupported file type '{target_path.suffix}'. "
                "/import only supports text-based files "
                "(e.g. .md, .txt, .json, .py, .log, …).[/red]"
            )
            return

        # Import from file
        try:
            async with aiofiles.open(target_path, encoding="utf-8") as f:
                content = await f.read()
        except UnicodeDecodeError:
            console.print(
                f"[red]Cannot import '{target_path.name}': "
                "the file does not appear to be valid UTF-8 text.[/red]"
            )
            return
        except OSError as e:
            console.print(f"[red]Failed to read file: {e}[/red]")
            return

        if not content.strip():
            console.print("[yellow]The file is empty, nothing to import.[/yellow]")
            return

        source_desc = f"file '{target_path.name}'"
    else:
        # Prevent importing current session into itself
        if target == soul.runtime.session.id:
            console.print("[yellow]Cannot import the current session into itself.[/yellow]")
            return

        # Try as session ID
        source_session = await Session.find(soul.runtime.session.work_dir, target)
        if source_session is None:
            console.print(f"[red]'{target}' is not a valid file path or session ID.[/red]")
            return

        # Load the source session's context
        source_context = Context(source_session.context_file)
        try:
            restored = await source_context.restore()
        except Exception as e:
            console.print(f"[red]Failed to load source session: {e}[/red]")
            return
        if not restored or not source_context.history:
            console.print("[yellow]The source session has no messages.[/yellow]")
            return

        content = stringify_context_history(source_context.history)
        source_desc = f"session '{target}'"

    # Build the import message
    import_text = f'<imported_context source="{source_desc}">\n{content}\n</imported_context>'

    message = Message(
        role="user",
        content=[
            system(
                f"The user has imported context from {source_desc}. "
                "This is a prior conversation history that may be relevant to the current session. "
                "Please review this context and use it to inform your responses."
            ),
            TextPart(text=import_text),
        ],
    )

    await soul.context.append_message(message)

    # Write to wire file so the import appears in session replay
    await soul.wire_file.append_message(
        TurnBegin(user_input=f"[Imported context from {source_desc}]")
    )
    await soul.wire_file.append_message(TurnEnd())

    console.print(
        f"[green]Imported context from {source_desc} "
        f"({len(content)} chars) into current session.[/green]"
    )

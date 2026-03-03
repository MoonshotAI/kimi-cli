from __future__ import annotations

import tempfile
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

import aiofiles
from kosong.message import Message
from loguru import logger

import kimi_cli.prompts as prompts
from kimi_cli.session import Session
from kimi_cli.soul import wire_send
from kimi_cli.soul.agent import load_agents_md
from kimi_cli.soul.context import Context
from kimi_cli.soul.message import system
from kimi_cli.utils.path import sanitize_cli_path
from kimi_cli.utils.slashcmd import SlashCommandRegistry
from kimi_cli.wire.types import StatusUpdate, TextPart

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul

type SoulSlashCmdFunc = Callable[[KimiSoul, str], None | Awaitable[None]]
"""
A function that runs as a KimiSoul-level slash command.

Raises:
    Any exception that can be raised by `Soul.run`.
"""

registry = SlashCommandRegistry[SoulSlashCmdFunc]()


@registry.command
async def init(soul: KimiSoul, args: str):
    """Analyze the codebase and generate an `AGENTS.md` file"""
    from kimi_cli.soul.kimisoul import KimiSoul

    with tempfile.TemporaryDirectory() as temp_dir:
        tmp_context = Context(file_backend=Path(temp_dir) / "context.jsonl")
        tmp_soul = KimiSoul(soul.agent, context=tmp_context)
        await tmp_soul.run(prompts.INIT)

    agents_md = await load_agents_md(soul.runtime.builtin_args.KIMI_WORK_DIR)
    system_message = system(
        "The user just ran `/init` slash command. "
        "The system has analyzed the codebase and generated an `AGENTS.md` file. "
        f"Latest AGENTS.md file content:\n{agents_md}"
    )
    await soul.context.append_message(Message(role="user", content=[system_message]))


@registry.command
async def compact(soul: KimiSoul, args: str):
    """Compact the context (optionally with a custom focus, e.g. /compact keep db discussions)"""
    if soul.context.n_checkpoints == 0:
        wire_send(TextPart(text="The context is empty."))
        return

    logger.info("Running `/compact`")
    await soul.compact_context(custom_instruction=args.strip())
    wire_send(TextPart(text="The context has been compacted."))
    wire_send(StatusUpdate(context_usage=soul.status.context_usage))


@registry.command(aliases=["reset"])
async def clear(soul: KimiSoul, args: str):
    """Clear the context"""
    logger.info("Running `/clear`")
    await soul.context.clear()
    wire_send(TextPart(text="The context has been cleared."))
    wire_send(StatusUpdate(context_usage=soul.status.context_usage))


@registry.command
async def yolo(soul: KimiSoul, args: str):
    """Toggle YOLO mode (auto-approve all actions)"""
    if soul.runtime.approval.is_yolo():
        soul.runtime.approval.set_yolo(False)
        wire_send(TextPart(text="You only die once! Actions will require approval."))
    else:
        soul.runtime.approval.set_yolo(True)
        wire_send(TextPart(text="You only live once! All actions will be auto-approved."))


@registry.command(name="add-dir")
async def add_dir(soul: KimiSoul, args: str):
    """Add a directory to the workspace. Usage: /add-dir <path>. Run without args to list added dirs"""  # noqa: E501
    from kaos.path import KaosPath

    from kimi_cli.utils.path import is_within_directory, list_directory, sanitize_cli_path

    args = sanitize_cli_path(args)
    if not args:
        if not soul.runtime.additional_dirs:
            wire_send(TextPart(text="No additional directories. Usage: /add-dir <path>"))
        else:
            lines = ["Additional directories:"]
            for d in soul.runtime.additional_dirs:
                lines.append(f"  - {d}")
            wire_send(TextPart(text="\n".join(lines)))
        return

    path = KaosPath(args).expanduser().canonical()

    if not await path.exists():
        wire_send(TextPart(text=f"Directory does not exist: {path}"))
        return
    if not await path.is_dir():
        wire_send(TextPart(text=f"Not a directory: {path}"))
        return

    # Check if already added (exact match)
    if path in soul.runtime.additional_dirs:
        wire_send(TextPart(text=f"Directory already in workspace: {path}"))
        return

    # Check if it's within the work_dir (already accessible)
    work_dir = soul.runtime.builtin_args.KIMI_WORK_DIR
    if is_within_directory(path, work_dir):
        wire_send(TextPart(text=f"Directory is already within the working directory: {path}"))
        return

    # Check if it's within an already-added additional directory (redundant)
    for existing in soul.runtime.additional_dirs:
        if is_within_directory(path, existing):
            wire_send(
                TextPart(
                    text=f"Directory is already within an added directory `{existing}`: {path}"
                )
            )
            return

    # Validate readability before committing any state changes
    try:
        ls_output = await list_directory(path)
    except OSError as e:
        wire_send(TextPart(text=f"Cannot read directory: {path} ({e})"))
        return

    # Add the directory (only after readability is confirmed)
    soul.runtime.additional_dirs.append(path)

    # Persist to session state
    soul.runtime.session.state.additional_dirs.append(str(path))
    soul.runtime.session.save_state()

    # Inject a system message to inform the LLM about the new directory
    system_message = system(
        f"The user has added an additional directory to the workspace: `{path}`\n\n"
        f"Directory listing:\n```\n{ls_output}\n```\n\n"
        "You can now read, write, search, and glob files in this directory "
        "as if it were part of the working directory."
    )
    await soul.context.append_message(Message(role="user", content=[system_message]))

    wire_send(TextPart(text=f"Added directory to workspace: {path}"))
    logger.info("Added additional directory: {path}", path=path)


@registry.command
async def export(soul: KimiSoul, args: str):
    """Export current session context to a markdown file"""
    from kimi_cli.utils.export import build_export_markdown

    history = list(soul.context.history)
    if not history:
        wire_send(TextPart(text="No messages to export."))
        return

    session = soul.runtime.session
    now = datetime.now()
    short_id = session.id[:8]
    default_name = f"kimi-export-{short_id}-{now.strftime('%Y%m%d-%H%M%S')}.md"

    cleaned = sanitize_cli_path(args)
    if cleaned:
        output = Path(cleaned).expanduser()
        if output.is_dir():
            output = output / default_name
    else:
        output = Path(str(session.work_dir)) / default_name

    content = build_export_markdown(
        session_id=session.id,
        work_dir=str(session.work_dir),
        history=history,
        token_count=soul.context.token_count,
        now=now,
    )

    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        async with aiofiles.open(output, "w", encoding="utf-8") as f:
            await f.write(content)
    except OSError as e:
        wire_send(TextPart(text=f"Failed to write export file: {e}"))
        return

    wire_send(TextPart(text=f"Exported {len(history)} messages to {output}"))


@registry.command(name="import")
async def import_context(soul: KimiSoul, args: str):
    """Import context from a file or session ID"""
    from kimi_cli.utils.export import stringify_context_history

    target = sanitize_cli_path(args)
    if not target:
        wire_send(TextPart(text="Usage: /import <file_path or session_id>"))
        return

    target_path = Path(target).expanduser()

    if target_path.exists() and target_path.is_file():
        # Check file extension
        from kimi_cli.utils.export import is_importable_file

        if not is_importable_file(target_path.name):
            wire_send(
                TextPart(
                    text=f"Unsupported file type '{target_path.suffix}'. "
                    "/import only supports text-based files "
                    "(e.g. .md, .txt, .json, .py, .log, …)."
                )
            )
            return

        # Import from file
        try:
            async with aiofiles.open(target_path, encoding="utf-8") as f:
                content = await f.read()
        except UnicodeDecodeError:
            wire_send(
                TextPart(
                    text=f"Cannot import '{target_path.name}': "
                    "the file does not appear to be valid UTF-8 text."
                )
            )
            return
        except OSError as e:
            wire_send(TextPart(text=f"Failed to read file: {e}"))
            return

        if not content.strip():
            wire_send(TextPart(text="The file is empty, nothing to import."))
            return

        source_desc = f"file '{target_path.name}'"
    else:
        # Prevent self-import
        if target == soul.runtime.session.id:
            wire_send(TextPart(text="Cannot import the current session into itself."))
            return

        # Try as session ID
        source_session = await Session.find(soul.runtime.session.work_dir, target)
        if source_session is None:
            wire_send(TextPart(text=f"'{target}' is not a valid file path or session ID."))
            return

        source_context = Context(source_session.context_file)
        try:
            restored = await source_context.restore()
        except Exception as e:
            wire_send(TextPart(text=f"Failed to load source session: {e}"))
            return
        if not restored or not source_context.history:
            wire_send(TextPart(text="The source session has no messages."))
            return

        content = stringify_context_history(source_context.history)
        source_desc = f"session '{target}'"

    # Build and append import message
    import_text = f'<imported_context source="{source_desc}">\n{content}\n</imported_context>'
    message = Message(
        role="user",
        content=[
            system(
                f"The user has imported context from {source_desc}. "
                "This is a prior conversation history that may be relevant "
                "to the current session. "
                "Please review this context and use it to inform your responses."
            ),
            TextPart(text=import_text),
        ],
    )
    await soul.context.append_message(message)
    wire_send(TextPart(text=f"Imported context from {source_desc} ({len(content)} chars)."))

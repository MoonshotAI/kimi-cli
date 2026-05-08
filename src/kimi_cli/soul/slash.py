from __future__ import annotations

import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING

from kaos.path import KaosPath
from kosong.message import Message

import kimi_cli.prompts as prompts
from kimi_cli import logger
from kimi_cli.soul import wire_send
from kimi_cli.soul.agent import load_agents_md
from kimi_cli.soul.context import Context
from kimi_cli.soul.dynamic_injections.afk_mode import AFK_DISABLED_REMINDER
from kimi_cli.soul.message import system, system_reminder
from kimi_cli.utils.export import is_sensitive_file
from kimi_cli.utils.path import sanitize_cli_path, shorten_home
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
    from kimi_cli.telemetry import track

    track("init_complete")


@registry.command
async def compact(soul: KimiSoul, args: str):
    """Compact the context (optionally with a custom focus, e.g. /compact keep db discussions)"""
    if soul.context.n_checkpoints == 0:
        wire_send(TextPart(text="The context is empty."))
        return

    logger.info("Running `/compact`")
    instruction = args.strip()
    await soul.compact_context(manual=True, custom_instruction=instruction)
    wire_send(TextPart(text="The context has been compacted."))
    snap = soul.status
    wire_send(
        StatusUpdate(
            context_usage=snap.context_usage,
            context_tokens=snap.context_tokens,
            max_context_tokens=snap.max_context_tokens,
        )
    )


@registry.command(aliases=["reset"])
async def clear(soul: KimiSoul, args: str):
    """Clear the context"""
    logger.info("Running `/clear`")
    await soul.context.clear()
    await soul.context.write_system_prompt(soul.agent.system_prompt)
    wire_send(TextPart(text="The context has been cleared."))
    snap = soul.status
    wire_send(
        StatusUpdate(
            context_usage=snap.context_usage,
            context_tokens=snap.context_tokens,
            max_context_tokens=snap.max_context_tokens,
        )
    )


@registry.command
async def yolo(soul: KimiSoul, args: str):
    """Toggle YOLO mode (auto-approve all actions)"""
    from kimi_cli.telemetry import track

    # Inspect only the yolo flag: afk is independent and is toggled by /afk.
    if soul.runtime.approval.is_yolo_flag():
        soul.runtime.approval.set_yolo(False)
        track("yolo_toggle", enabled=False)
        if soul.runtime.approval.is_afk():
            # Yolo off but afk still on -> tool calls remain auto-approved.
            # Don't mislead the user into thinking approvals just came back.
            wire_send(
                TextPart(
                    text=(
                        "Yolo disabled, but afk is still on — tool calls remain "
                        "auto-approved. Use /afk to turn off afk."
                    )
                )
            )
        else:
            wire_send(TextPart(text="You only die once! Actions will require approval."))
    else:
        soul.runtime.approval.set_yolo(True)
        track("yolo_toggle", enabled=True)
        wire_send(TextPart(text="You only live once! All actions will be auto-approved."))


@registry.command
async def afk(soul: KimiSoul, args: str):
    """Toggle afk mode (auto-dismiss AskUserQuestion, auto-approve tool calls)"""
    from kimi_cli.telemetry import track

    if soul.runtime.approval.is_afk():
        soul.runtime.approval.set_afk(False)
        await soul.notify_afk_changed(False)
        await soul.context.append_message(
            Message(role="user", content=[system_reminder(AFK_DISABLED_REMINDER)])
        )
        track("afk_toggle", enabled=False)
        if soul.runtime.approval.is_yolo_flag():
            wire_send(
                TextPart(
                    text=("afk mode disabled. You are back at the terminal. Yolo is still on.")
                )
            )
        else:
            wire_send(TextPart(text="afk mode disabled. You are back at the terminal."))
    else:
        soul.runtime.approval.set_afk(True)
        await soul.notify_afk_changed(True)
        track("afk_toggle", enabled=True)
        wire_send(
            TextPart(
                text=(
                    "afk mode enabled. AskUserQuestion will be auto-dismissed "
                    "and tool calls auto-approved."
                )
            )
        )


@registry.command
async def plan(soul: KimiSoul, args: str):
    """Toggle plan mode. Usage: /plan [on|off|view|clear]"""
    subcmd = args.strip().lower()

    if subcmd == "on":
        if not soul.plan_mode:
            await soul.toggle_plan_mode_from_manual()
        plan_path = soul.get_plan_file_path()
        wire_send(TextPart(text=f"Plan mode ON. Plan file: {plan_path}"))
        wire_send(StatusUpdate(plan_mode=soul.plan_mode))
    elif subcmd == "off":
        if soul.plan_mode:
            await soul.toggle_plan_mode_from_manual()
        wire_send(TextPart(text="Plan mode OFF. All tools are now available."))
        wire_send(StatusUpdate(plan_mode=soul.plan_mode))
    elif subcmd == "view":
        content = soul.read_current_plan()
        if content:
            wire_send(TextPart(text=content))
        else:
            wire_send(TextPart(text="No plan file found for this session."))
    elif subcmd == "clear":
        soul.clear_current_plan()
        wire_send(TextPart(text="Plan cleared."))
    else:
        # Default: toggle
        new_state = await soul.toggle_plan_mode_from_manual()
        if new_state:
            plan_path = soul.get_plan_file_path()
            wire_send(
                TextPart(
                    text=f"Plan mode ON. Write your plan to: {plan_path}\n"
                    "Use ExitPlanMode when done, or /plan off to exit manually."
                )
            )
        else:
            wire_send(TextPart(text="Plan mode OFF. All tools are now available."))
        wire_send(StatusUpdate(plan_mode=soul.plan_mode))


@registry.command(name="add-dir")
async def add_dir(soul: KimiSoul, args: str):
    """Add a directory to the workspace. Usage: /add-dir <path>. Run without args to list added dirs"""  # noqa: E501
    from kaos.path import KaosPath

    from kimi_cli.utils.path import is_within_directory, list_directory

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
    from kimi_cli.utils.export import perform_export

    session = soul.runtime.session
    result = await perform_export(
        history=list(soul.context.history),
        session_id=session.id,
        work_dir=str(session.work_dir),
        token_count=soul.context.token_count,
        args=args,
        default_dir=Path(str(session.work_dir)),
    )
    if isinstance(result, str):
        wire_send(TextPart(text=result))
        return
    output, count = result
    display = shorten_home(KaosPath(str(output)))
    wire_send(TextPart(text=f"Exported {count} messages to {display}"))
    wire_send(
        TextPart(
            text="  Note: The exported file may contain sensitive information. "
            "Please be cautious when sharing it externally."
        )
    )


@registry.command(name="import")
async def import_context(soul: KimiSoul, args: str):
    """Import context from a file or session ID"""
    from kimi_cli.utils.export import perform_import

    target = sanitize_cli_path(args)
    if not target:
        wire_send(TextPart(text="Usage: /import <file_path or session_id>"))
        return

    session = soul.runtime.session
    raw_max_context_size = (
        soul.runtime.llm.max_context_size if soul.runtime.llm is not None else None
    )
    max_context_size = (
        raw_max_context_size
        if isinstance(raw_max_context_size, int) and raw_max_context_size > 0
        else None
    )
    result = await perform_import(
        target=target,
        current_session_id=session.id,
        work_dir=session.work_dir,
        context=soul.context,
        max_context_size=max_context_size,
    )
    if isinstance(result, str):
        wire_send(TextPart(text=result))
        return

    source_desc, content_len = result
    wire_send(TextPart(text=f"Imported context from {source_desc} ({content_len} chars)."))
    if source_desc.startswith("file") and is_sensitive_file(Path(target).name):
        wire_send(
            TextPart(
                text="Warning: This file may contain secrets (API keys, tokens, credentials). "
                "The content is now part of your session context."
            )
        )

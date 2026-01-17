from __future__ import annotations

import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING

from kosong.message import Message
from loguru import logger

import gitrekt_cli.prompts as prompts
from gitrekt_cli.soul import wire_send
from gitrekt_cli.soul.agent import load_agents_md
from gitrekt_cli.soul.context import Context
from gitrekt_cli.soul.message import system
from gitrekt_cli.utils.slashcmd import SlashCommandRegistry
from gitrekt_cli.wire.types import TextPart

if TYPE_CHECKING:
    from gitrekt_cli.soul.gitrechtsoul import GitrektSoul

type SoulSlashCmdFunc = Callable[[GitrektSoul, str], None | Awaitable[None]]
"""
A function that runs as a GitrektSoul-level slash command.

Raises:
    Any exception that can be raised by `Soul.run`.
"""

registry = SlashCommandRegistry[SoulSlashCmdFunc]()


@registry.command
async def init(soul: GitrektSoul, args: str):
    """Analyze the codebase and generate an `AGENTS.md` file"""
    from gitrekt_cli.soul.gitrechtsoul import GitrektSoul

    with tempfile.TemporaryDirectory() as temp_dir:
        tmp_context = Context(file_backend=Path(temp_dir) / "context.jsonl")
        tmp_soul = GitrektSoul(soul.agent, context=tmp_context)
        await tmp_soul.run(prompts.INIT)

    agents_md = load_agents_md(soul.runtime.builtin_args.GITREKT_WORK_DIR)
    system_message = system(
        "The user just ran `/init` slash command. "
        "The system has analyzed the codebase and generated an `AGENTS.md` file. "
        f"Latest AGENTS.md file content:\n{agents_md}"
    )
    await soul.context.append_message(Message(role="user", content=[system_message]))


@registry.command
async def compact(soul: GitrektSoul, args: str):
    """Compact the context"""
    if soul.context.n_checkpoints == 0:
        wire_send(TextPart(text="The context is empty."))
        return

    logger.info("Running `/compact`")
    await soul.compact_context()
    wire_send(TextPart(text="The context has been compacted."))


@registry.command
async def yolo(soul: GitrektSoul, args: str):
    """Toggle YOLO mode (auto-approve all actions)"""
    if soul.runtime.approval.is_yolo():
        soul.runtime.approval.set_yolo(False)
        wire_send(TextPart(text="You only die once! Actions will require approval."))
    else:
        soul.runtime.approval.set_yolo(True)
        wire_send(TextPart(text="You only live once! All actions will be auto-approved."))

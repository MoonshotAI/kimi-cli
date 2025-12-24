from __future__ import annotations

import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING

from kosong.message import Message, TextPart
from loguru import logger

import kimi_cli.prompts as prompts
from kimi_cli.soul import wire_send
from kimi_cli.soul.agent import load_agents_md
from kimi_cli.soul.context import Context
from kimi_cli.soul.message import system
from kimi_cli.utils.slashcmd import SlashCommandRegistry

if TYPE_CHECKING:
    from kimi_cli.soul.kimisoul import KimiSoul

type SoulSlashCmdFunc = Callable[[KimiSoul, list[str]], None | Awaitable[None]]
"""
A function that runs as a KimiSoul-level slash command.

Raises:
    Any exception that can be raised by `Soul.run`.
"""

registry = SlashCommandRegistry[SoulSlashCmdFunc]()


@registry.command
async def init(soul: KimiSoul, args: list[str]):
    """Analyze the codebase and generate an `AGENTS.md` file"""
    from kimi_cli.soul.kimisoul import KimiSoul

    with tempfile.TemporaryDirectory() as temp_dir:
        tmp_context = Context(file_backend=Path(temp_dir) / "context.jsonl")
        tmp_soul = KimiSoul(soul.agent, context=tmp_context)
        tmp_soul.set_thinking(soul.thinking)
        await tmp_soul.run(prompts.INIT)

    agents_md = load_agents_md(soul.runtime.builtin_args.KIMI_WORK_DIR)
    system_message = system(
        "The user just ran `/init` slash command. "
        "The system has analyzed the codebase and generated an `AGENTS.md` file. "
        f"Latest AGENTS.md file content:\n{agents_md}"
    )
    await soul.context.append_message(Message(role="user", content=[system_message]))


@registry.command
async def compact(soul: KimiSoul, args: list[str]):
    """Compact the context"""
    if soul.context.n_checkpoints == 0:
        wire_send(TextPart(text="The context is empty."))
        return

    logger.info("Running `/compact`")
    await soul.compact_context()
    wire_send(TextPart(text="The context has been compacted."))


@registry.command
async def yolo(soul: KimiSoul, args: list[str]):
    """Enable YOLO mode (auto approve all actions)"""
    soul.runtime.approval.set_yolo(True)
    wire_send(TextPart(text="You only live once! All actions will be auto-approved."))


@registry.command
async def skills(soul: KimiSoul, args: list[str]):
    """List or manage available skills

    Usage:
      /skills             List all available skills
      /skills info <name> Show detailed info about a skill
      /skills refresh     Re-scan directories and refresh cache
    """
    from kimi_cli.skills import ActivateSkill, SkillsLoader, format_skill_info, format_skills_list
    from kimi_cli.soul.toolset import KimiToolset

    # Get skills from the toolset if available
    toolset = soul.agent.toolset
    skills_loader: SkillsLoader | None = None

    # Find ActivateSkill tool by type to get the skills loader
    if isinstance(toolset, KimiToolset):
        activate_skill = toolset.find(ActivateSkill)
        if activate_skill is not None:
            skills_loader = activate_skill.skills_loader

    if skills_loader is None:
        wire_send(TextPart(text="Skills system is not enabled."))
        return

    if not args:
        # List all skills
        skills_list = skills_loader.list_skills()
        output = format_skills_list(skills_list)
        wire_send(TextPart(text=output))
        return

    subcommand = args[0]

    if subcommand == "info" and len(args) > 1:
        skill_name = args[1]
        skill = skills_loader.load_full_skill(skill_name)
        if skill is None:
            wire_send(TextPart(text=f"Skill '{skill_name}' not found."))
            return
        output = format_skill_info(skill)
        wire_send(TextPart(text=output))
        return

    if subcommand == "refresh":
        skills_list = skills_loader.refresh()
        wire_send(TextPart(text=f"Refreshed skills. Found {len(skills_list)} skill(s)."))
        return

    # Unknown subcommand, show help
    wire_send(
        TextPart(
            text="""Usage: /skills [subcommand]

Subcommands:
  (none)          List all available skills
  info <name>     Show detailed info about a skill
  refresh         Re-scan directories and refresh skills cache
"""
        )
    )

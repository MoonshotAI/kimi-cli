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
from kimi_cli.soul.message import system
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
    await soul.compact_context(custom_instruction=args.strip())
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

    if soul.runtime.approval.is_yolo():
        soul.runtime.approval.set_yolo(False)
        track("yolo_toggle", enabled=False)
        wire_send(TextPart(text="You only die once! Actions will require approval."))
    else:
        soul.runtime.approval.set_yolo(True)
        track("yolo_toggle", enabled=True)
        wire_send(TextPart(text="You only live once! All actions will be auto-approved."))


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


def _format_pending_list(soul: KimiSoul) -> str:
    """Format the pending edits list for display."""
    pending = soul.runtime.session.state.pending_edits
    if not pending:
        return "待修改清单为空。"
    lines = [f"待修改清单（共 {len(pending)} 项）："]
    for i, edit in enumerate(pending, 1):
        lines.append(f"  {i}. [{edit.tool_name}] {edit.description}")
    return "\n".join(lines)


@registry.command
async def execute(soul: KimiSoul, args: str):
    """解除只读模式，并批量执行待修改清单中的操作"""
    if not soul.is_readonly:
        wire_send(TextPart(text="当前不处于只读模式，无需执行此命令。"))
        return

    pending = soul.runtime.session.state.pending_edits
    soul.set_readonly(False)

    if pending:
        # Build a system message instructing the AI to execute pending edits
        lines = [
            "用户已通过 /execute 解除只读模式。请按照以下待修改清单按顺序执行操作：",
            "",
        ]
        for i, edit in enumerate(pending, 1):
            lines.append(f"{i}. [{edit.tool_name}] {edit.description}")
        lines.extend([
            "",
            "注意：",
            "- 请严格按照上述顺序执行",
            "- 每个操作完成后等待结果再继续下一个",
            "- 如果某一步失败，请分析原因并决定是否继续",
            "- 执行完所有操作后，向用户汇报完成情况",
        ])
        await soul.context.append_message(
            Message(role="user", content=[system("\n".join(lines))])
        )
        # Clear the pending edits list
        soul.runtime.session.state.pending_edits = []
        soul.runtime.session.save_state()
        wire_send(TextPart(text="已解除只读模式，并将待修改清单注入对话上下文。AI 将按顺序执行。"))
    else:
        wire_send(TextPart(text="已解除只读模式。现在可以修改文件和执行 Shell 命令。"))

    wire_send(StatusUpdate(readonly_mode=False))


@registry.command
async def readonly(soul: KimiSoul, args: str):
    """进入只读模式，禁止修改文件和执行命令"""
    if soul.is_readonly:
        wire_send(TextPart(text="当前已处于只读模式。"))
        return

    soul.set_readonly(True)
    wire_send(TextPart(text="已进入只读模式。文件修改和 Shell 命令已被禁用。发送 /execute 可解除。"))
    wire_send(StatusUpdate(readonly_mode=True))


@registry.command(name="pending")
async def pending_list(soul: KimiSoul, args: str):
    """查看待修改清单"""
    text = _format_pending_list(soul)
    wire_send(TextPart(text=text))


@registry.command(name="pending-remove")
async def pending_remove(soul: KimiSoul, args: str):
    """按序号删除待修改清单中的某一项。Usage: /pending-remove <序号>"""
    pending = soul.runtime.session.state.pending_edits
    if not pending:
        wire_send(TextPart(text="待修改清单为空，无需删除。"))
        return

    arg = args.strip()
    if not arg:
        wire_send(TextPart(text="Usage: /pending-remove <序号>。使用 /pending 查看清单序号。"))
        return

    try:
        idx = int(arg)
    except ValueError:
        wire_send(TextPart(text=f"无效的序号: `{arg}`，请输入数字。"))
        return

    if idx < 1 or idx > len(pending):
        wire_send(TextPart(text=f"序号 {idx} 超出范围（共 {len(pending)} 项）。"))
        return

    removed = pending.pop(idx - 1)
    soul.runtime.session.save_state()
    wire_send(TextPart(text=f"已删除第 {idx} 项: [{removed.tool_name}] {removed.description}"))


@registry.command(name="pending-edit")
async def pending_edit(soul: KimiSoul, args: str):
    """把指定项的参数注入对话上下文以便修改。Usage: /pending-edit <序号>"""
    pending = soul.runtime.session.state.pending_edits
    if not pending:
        wire_send(TextPart(text="待修改清单为空，无可编辑项。"))
        return

    arg = args.strip()
    if not arg:
        wire_send(TextPart(text="Usage: /pending-edit <序号>。使用 /pending 查看清单序号。"))
        return

    try:
        idx = int(arg)
    except ValueError:
        wire_send(TextPart(text=f"无效的序号: `{arg}`，请输入数字。"))
        return

    if idx < 1 or idx > len(pending):
        wire_send(TextPart(text=f"序号 {idx} 超出范围（共 {len(pending)} 项）。"))
        return

    edit = pending[idx - 1]
    import json

    params_json = json.dumps(edit.params, ensure_ascii=False, indent=2)
    lines = [
        f"用户希望修改待修改清单中的第 {idx} 项。",
        f"原操作工具: {edit.tool_name}",
        f"原描述: {edit.description}",
        f"原参数:\n```json\n{params_json}\n```",
        "",
        "请根据用户的新要求，直接调用相应的工具重新发起操作（系统会将其记录为新待修改清单项）。",
        f"旧项（第 {idx} 项）可以由用户稍后发送 /pending-remove {idx} 删除。",
    ]
    await soul.context.append_message(
        Message(role="user", content=[system("\n".join(lines))])
    )
    wire_send(
        TextPart(
            text=f"已将第 {idx} 项的参数注入对话上下文。请告诉 AI 你想如何修改这一项。"
        )
    )


@registry.command(name="pending-clear")
async def pending_clear(soul: KimiSoul, args: str):
    """清空待修改清单"""
    count = len(soul.runtime.session.state.pending_edits)
    soul.runtime.session.state.pending_edits = []
    soul.runtime.session.save_state()
    wire_send(TextPart(text=f"已清空待修改清单（清除了 {count} 项）。"))


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

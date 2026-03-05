from __future__ import annotations

import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING

from kaos.path import KaosPath
from kosong.message import Message
from loguru import logger

import kimi_cli.prompts as prompts
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


@registry.command
async def plan(soul: KimiSoul, args: str):
    """Generate and select from multiple implementation approaches.
    
    Usage:
      /plan <task description>       Generate new plan
      /plan --list                   List saved plans  
      /plan --reuse <id>             Reuse saved plan
      /plan --reuse <id> --option N  Reuse with specific option
      /plan --last                   Reuse last plan
      /plan --delete <id>            Delete saved plan
      /plan --help                   Show help
    """
    from kimi_cli.plans import (
        PlanGenerator, InteractivePlanMenu, PlanStorage, 
        PlanDetailView, PlanGenerationError
    )
    from kimi_cli.plans.mode import ModeManager, PlanMode
    from kimi_cli.wire.types import TextPart
    from kimi_cli.soul import wire_send
    
    args = args.strip()
    storage = PlanStorage()
    
    # Handle --help
    if args == '--help' or args == '-h':
        wire_send(TextPart(text="""
/plan - Intelligent planning system

Usage:
  /plan <description>              Generate plans for a task
  /plan --list                     Show saved plans
  /plan --reuse <id>               Reuse a saved plan
  /plan --reuse <id> --option N    Reuse with specific option (1-3)
  /plan --last                     Reuse most recent plan
  /plan --delete <id>              Delete a saved plan

Examples:
  /plan add user authentication
  /plan --list
  /plan --reuse 20240304_153045_auth
  /plan --last
""".strip()))
        return
    
    # Handle --list
    if args == '--list' or args == '-l':
        plans = storage.list()
        if not plans:
            wire_send(TextPart(text="No saved plans. Use `/plan <description>` to create one."))
            return
        
        lines = ["Saved plans:", ""]
        for plan_id, query, created_at in plans[:20]:  # Show last 20
            date_str = created_at.strftime("%Y-%m-%d %H:%M")
            lines.append(f"  {plan_id}")
            lines.append(f"    Query: {query[:50]}{'...' if len(query) > 50 else ''}")
            lines.append(f"    Created: {date_str}")
            lines.append("")
        
        wire_send(TextPart(text="\n".join(lines)))
        return
    
    # Handle --delete
    if args.startswith('--delete ') or args.startswith('-d '):
        plan_id = args.split(' ', 1)[1].strip()
        if storage.delete(plan_id):
            wire_send(TextPart(text=f"✅ Deleted plan: {plan_id}"))
        else:
            wire_send(TextPart(text=f"❌ Plan not found: {plan_id}"))
        return
    
    # Handle --reuse
    if args.startswith('--reuse ') or args.startswith('-r '):
        # Parse: --reuse <id> or --reuse <id> --option
        parts = args.split()
        plan_id = parts[1]
        option_index = None
        
        if '--option' in parts or '-o' in parts:
            # Find option value
            for i, part in enumerate(parts):
                if part in ('--option', '-o') and i + 1 < len(parts):
                    try:
                        option_index = int(parts[i + 1]) - 1  # Convert to 0-based
                    except ValueError:
                        pass
        
        plan = storage.load(plan_id)
        if plan is None:
            wire_send(TextPart(text=f"❌ Plan not found: {plan_id}"))
            return
        
        # If no option specified, show interactive menu
        if option_index is None:
            menu = InteractivePlanMenu()
            selected = menu.show(plan)
            if selected is None:
                wire_send(TextPart(text="❌ Cancelled."))
                return
            option_index = selected
        
        # Validate option index
        if option_index < 0 or option_index >= len(plan.options):
            wire_send(TextPart(text=f"❌ Invalid option: {option_index + 1}"))
            return
        
        # Show detail view and execute
        detail = PlanDetailView()
        if detail.show(plan, option_index):
            # Execute (Phase 3 will expand)
            selected = plan.options[option_index]
            wire_send(TextPart(text=f"✅ Executing: {selected.title}"))
            # TODO: Inject into context and execute
        else:
            wire_send(TextPart(text="❌ Cancelled."))
        return
    
    # Handle --last
    if args == '--last':
        plan = storage.get_last()
        if plan is None:
            wire_send(TextPart(text="❌ No saved plans found."))
            return
        
        menu = InteractivePlanMenu()
        selected = menu.show(plan)
        if selected is None:
            wire_send(TextPart(text="❌ Cancelled."))
            return
        
        detail = PlanDetailView()
        if detail.show(plan, selected):
            selected_opt = plan.options[selected]
            wire_send(TextPart(text=f"✅ Executing: {selected_opt.title}"))
        else:
            wire_send(TextPart(text="❌ Cancelled."))
        return
    
    # Default: generate new plan
    if not args:
        wire_send(TextPart(text="Usage: /plan <description> or /plan --help"))
        return
    
    # Check if LLM is configured
    if soul.runtime.llm is None:
        wire_send(TextPart(text="Error: LLM not configured. Cannot generate plans."))
        return

    # Show "thinking" message
    wire_send(TextPart(text="🤔 Analyzing your request and generating implementation options..."))

    try:
        # Generate plan
        generator = PlanGenerator(soul.runtime.llm)
        plan = await generator.generate(
            user_request=args,
            work_dir=str(soul.runtime.builtin_args.KIMI_WORK_DIR),
            files=[],  # TODO: Get from context
            patterns=[],  # TODO: Get from AGENTS.md
        )

        # Show interactive menu for selection
        menu = InteractivePlanMenu()
        selected = menu.show(plan)
        
        if selected is None:
            wire_send(TextPart(text="❌ Cancelled."))
            return
        
        # Show detail view
        detail = PlanDetailView()
        if not detail.show(plan, selected):
            wire_send(TextPart(text="❌ Cancelled."))
            return
        
        # Save plan if configured (check ModeManager for setting)
        try:
            mode_mgr = ModeManager()
            if mode_mgr.current_mode == PlanMode.AUTO_SAVE:
                storage.save(plan)
                wire_send(TextPart(text=f"💾 Plan saved: {plan.plan_id}"))
        except Exception:
            # If mode manager not available, still try to save
            storage.save(plan)
            wire_send(TextPart(text=f"💾 Plan saved: {plan.plan_id}"))
        
        # Execute the selected option
        selected_opt = plan.options[selected]
        wire_send(TextPart(text=f"✅ Executing: {selected_opt.title}"))
        # TODO: Phase 3 - Inject plan into context and execute

    except PlanGenerationError as e:
        wire_send(TextPart(text=f"❌ Failed to generate plan: {e}"))
    except Exception as e:
        wire_send(TextPart(text=f"❌ Unexpected error: {e}"))


@registry.command(name="plan-execute")
async def plan_execute(soul: KimiSoul, args: str):
    """Execute a saved plan with full execution engine.
    
    Usage:
      /plan-execute <plan_id>       Execute plan (smart resume)
      /plan-execute --fresh         Start fresh, ignore checkpoint
      /plan-execute --resume        Force resume from checkpoint
    """
    from kimi_cli.plans import PlanStorage, PlanExecutor
    from kimi_cli.plans.checkpoint import CheckpointManager
    from kimi_cli.plans.progress import ExecutionProgressUI
    from kimi_cli.wire.types import TextPart
    from kimi_cli.soul import wire_send
    
    args = args.strip()
    
    # Parse flags
    fresh = "--fresh" in args
    resume = "--resume" in args
    
    # Remove flags to get plan_id
    plan_id = args.replace("--fresh", "").replace("--resume", "").strip()
    
    if not plan_id:
        wire_send(TextPart(text="""
Usage: /plan-execute <plan_id> [options]

Options:
  --fresh    Start fresh, ignore any checkpoint
  --resume   Force resume from checkpoint

Examples:
  /plan-execute 20240304_153045_auth
  /plan-execute 20240304_153045_auth --fresh
  /plan-execute --resume 20240304_153045_auth
""".strip()))
        return
    
    # Load plan
    storage = PlanStorage()
    plan = storage.load(plan_id)
    
    if not plan:
        wire_send(TextPart(text=f"❌ Plan not found: {plan_id}"))
        wire_send(TextPart(text="Use `/plan --list` to see saved plans."))
        return
    
    # Check if plan has steps
    if not plan.steps:
        # Convert options to steps for Phase 1/2 plans
        from kimi_cli.plans.models import PlanStep
        plan.steps = [
            PlanStep(
                id=f"step_{i}",
                name=opt.title,
                description=opt.description,
                depends_on=[],  # Sequential for now
                can_parallel=False,
                estimated_duration=opt.estimated_time,
            )
            for i, opt in enumerate(plan.options)
        ]
    
    # Check for checkpoint status
    checkpoint_mgr = CheckpointManager()
    if not fresh and not resume:
        resume = checkpoint_mgr.should_resume(plan_id)
        if resume:
            wire_send(TextPart(text=f"💾 Resuming from checkpoint..."))
    
    # Check LLM
    if soul.runtime.llm is None:
        wire_send(TextPart(text="❌ LLM not configured. Cannot execute plan."))
        return
    
    # Create executor with progress UI
    executor = PlanExecutor(
        llm=soul.runtime.llm,
        max_parallel=3,
        enable_checkpoints=True,
    )
    
    progress_ui = ExecutionProgressUI()
    
    # Add listeners to update UI
    def on_step_update(step_exec):
        progress_ui.update()
    
    executor.add_listener("step_start", on_step_update)
    executor.add_listener("step_complete", on_step_update)
    executor.add_listener("step_failed", on_step_update)
    
    # Execute
    wire_send(TextPart(text=f"🚀 Executing plan: {plan_id}"))
    wire_send(TextPart(text=f"   Query: {plan.query[:60]}..." if len(plan.query) > 60 else f"   Query: {plan.query}"))
    
    try:
        progress_ui.start(None)
        
        execution = await executor.execute(
            plan=plan,
            resume=resume,
            fresh=fresh,
        )
        
        progress_ui.stop()
        
        # Show summary
        completed, total = execution.get_progress()
        duration = execution.get_duration()
        
        if execution.overall_status == "completed":
            wire_send(TextPart(
                text=f"✅ Plan completed successfully!\n"
                     f"   Steps: {completed}/{total}\n"
                     f"   Duration: {int(duration)}s"
            ))
        elif execution.overall_status == "partial":
            wire_send(TextPart(
                text=f"⚠️ Plan completed with skipped steps.\n"
                     f"   Steps: {completed}/{total}\n"
                     f"   Duration: {int(duration)}s"
            ))
        else:
            wire_send(TextPart(
                text=f"❌ Plan failed.\n"
                     f"   Steps: {completed}/{total}\n"
                     f"   Duration: {int(duration)}s"
            ))
        
        # Clean up checkpoint if completed
        if execution.overall_status == "completed":
            checkpoint_mgr.delete(plan_id)
        
    except ExecutionAborted:
        progress_ui.stop()
        wire_send(TextPart(text="❌ Execution aborted by user."))
        wire_send(TextPart(text="Use `/plan-execute --resume` to continue."))
        
    except Exception as e:
        progress_ui.stop()
        wire_send(TextPart(text=f"❌ Execution error: {e}"))
        import logging
        logging.getLogger(__name__).exception("Plan execution failed")


@registry.command(name="plan-checkpoint")
async def plan_checkpoint(soul: KimiSoul, args: str):
    """Manage execution checkpoints.
    
    Usage:
      /plan-checkpoint --list        List checkpoints
      /plan-checkpoint --delete <id> Delete checkpoint
    """
    from kimi_cli.plans.checkpoint import CheckpointManager
    from kimi_cli.wire.types import TextPart
    from kimi_cli.soul import wire_send
    
    args = args.strip()
    checkpoint_mgr = CheckpointManager()
    
    if args == "--list" or args == "-l":
        checkpoints = checkpoint_mgr.list()
        if not checkpoints:
            wire_send(TextPart(text="No checkpoints found."))
            return
        
        lines = ["Checkpoints:", ""]
        for plan_id, mtime in checkpoints[:20]:
            lines.append(f"  {plan_id}")
            lines.append(f"    Modified: {mtime.strftime('%Y-%m-%d %H:%M')}")
        
        wire_send(TextPart(text="\n".join(lines)))
        return
    
    if args.startswith("--delete ") or args.startswith("-d "):
        plan_id = args.split(' ', 1)[1].strip()
        if checkpoint_mgr.delete(plan_id):
            wire_send(TextPart(text=f"✅ Deleted checkpoint: {plan_id}"))
        else:
            wire_send(TextPart(text=f"❌ Checkpoint not found: {plan_id}"))
        return
    
    wire_send(TextPart(text="""
Usage: /plan-checkpoint [option]

Options:
  --list, -l           List all checkpoints
  --delete, -d <id>    Delete specific checkpoint
""".strip()))


@registry.command(name="plan-history")
async def plan_history(soul: KimiSoul, args: str):
    """Show recent plan execution history for the current session.
    
    Usage:
      /plan-history           Show last 10 entries
      /plan-history --clear   Clear session history
    """
    from kimi_cli.plans.history import get_history
    from kimi_cli.wire.types import TextPart
    from kimi_cli.soul import wire_send
    
    args = args.strip()
    history = get_history()
    
    if args == "--clear":
        history.clear()
        wire_send(TextPart(text="✅ Session history cleared."))
        return
    
    entries = history.get_entries(limit=10)
    
    if not entries:
        wire_send(TextPart(text="No plans executed in this session."))
        return
    
    lines = ["# Recent Plans", ""]
    for e in entries:
        status_emoji = "✅" if e.outcome == "completed" else "❌" if e.outcome == "failed" else "⚠️"
        query_display = e.query[:50] + "..." if len(e.query) > 50 else e.query
        lines.append(f"{status_emoji} {query_display}")
        lines.append(f"   ID: {e.plan_id}")
        lines.append(f"   Outcome: {e.outcome}")
        if e.files_changed > 0:
            lines.append(f"   Files changed: {e.files_changed}")
        lines.append("")
    
    # Add session stats
    stats = history.get_stats()
    lines.append("---")
    lines.append(f"Session: {stats['successful']}/{stats['total']} successful ({stats['success_rate']:.0f}%)")
    
    wire_send(TextPart(text="\n".join(lines)))


@registry.command(name="plan-stats")
async def plan_stats(soul: KimiSoul, args: str):
    """Show plan execution statistics across all saved plans.
    
    Usage:
      /plan-stats              Show overall statistics
      /plan-stats --trends     Show 7-day usage trends
    """
    from kimi_cli.plans.storage import PlanStorage
    from kimi_cli.plans.checkpoint import CheckpointManager
    from kimi_cli.plans.analytics import PlanAnalytics
    from kimi_cli.wire.types import TextPart
    from kimi_cli.soul import wire_send
    
    args = args.strip()
    storage = PlanStorage()
    ckpt = CheckpointManager()
    analytics = PlanAnalytics(storage, ckpt)
    
    if args == "--trends":
        trends = analytics.get_trends(days=7)
        lines = ["# Plan Usage Trends (Last 7 Days)", ""]
        lines.append(f"Total executions: {trends['total_recent']}")
        if trends['daily_executions']:
            lines.append("\nDaily breakdown:")
            for day, count in sorted(trends['daily_executions'].items()):
                lines.append(f"  {day}: {count} execution(s)")
        else:
            lines.append("\nNo executions in the last 7 days.")
        wire_send(TextPart(text="\n".join(lines)))
        return
    
    stats = analytics.get_overall_stats()
    
    lines = ["# Plan Statistics", ""]
    lines.append(f"Total Plans: {stats.get('total_plans', 0)}")
    lines.append(f"Total Executions: {stats.get('total_executions', 0)}")
    
    if stats.get('total_executions', 0) > 0:
        lines.append("")
        lines.append("Outcomes:")
        lines.append(f"  ✅ Completed: {stats.get('completed', 0)}")
        if stats.get('partial', 0) > 0:
            lines.append(f"  ⚠️  Partial: {stats.get('partial', 0)}")
        if stats.get('failed', 0) > 0:
            lines.append(f"  ❌ Failed: {stats.get('failed', 0)}")
        if stats.get('aborted', 0) > 0:
            lines.append(f"  🛑 Aborted: {stats.get('aborted', 0)}")
        lines.append("")
        lines.append(f"Success Rate: {stats.get('success_rate', 0):.1f}%")
        lines.append(f"Avg Execution Time: {stats.get('avg_execution_time_seconds', 0):.1f}s")
    
    wire_send(TextPart(text="\n".join(lines)))

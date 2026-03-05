"""
GSD (Get Shit Done) slash commands for plan mode.

Commands:
  /gsd new <name> <description>  - Initialize GSD project
  /gsd status                    - Show current project status
  /gsd task add <title>          - Add new task
  /gsd task start <id>           - Start working on task
  /gsd task done <id> [notes]    - Complete task
  /gsd phase <name>              - Move to phase
  /gsd tree                      - Show project tree
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from kimi_cli.wire.types import TextPart


def handle_gsd_command(args: str) -> str:
    """Handle GSD slash commands.
    
    Args:
        args: Command arguments
        
    Returns:
        Response text
    """
    from kimi_cli.plans.gsd import get_gsd_manager, GSDPhase
    
    args = args.strip()
    parts = args.split(maxsplit=1)
    
    if not parts:
        return _gsd_help()
    
    command = parts[0].lower()
    rest = parts[1] if len(parts) > 1 else ""
    
    manager = get_gsd_manager()
    
    # Initialize new project
    if command == "new":
        return _handle_gsd_new(rest)
    
    # Show status
    elif command == "status" or command == "st":
        if not manager.has_active_project():
            return "❌ No active GSD project. Use `/gsd new <name> <description>` to create one."
        manager.load_project()
        manager.show_status()
        return ""  # Output already printed
    
    # Show tree
    elif command == "tree":
        if not manager.has_active_project():
            return "❌ No active GSD project."
        manager.load_project()
        manager.show_tree()
        return ""
    
    # Task commands
    elif command == "task":
        return _handle_gsd_task(rest, manager)
    
    # Phase commands
    elif command == "phase":
        return _handle_gsd_phase(rest, manager)
    
    # Unknown command
    else:
        return f"❌ Unknown command: {command}\n\n{_gsd_help()}"


def _gsd_help() -> str:
    """Return help text."""
    return """
🚀 GSD (Get Shit Done) - Structured project planning

Usage:
  /gsd new <name> <description>  Create new GSD project
  /gsd status                    Show project status
  /gsd tree                      Show project as tree
  /gsd task add <title>          Add task to current phase
  /gsd task start <id>           Start working on task
  /gsd task done <id> [notes]    Complete task
  /gsd phase <name>              Move to phase (discuss/research/plan/execute/verify)

Examples:
  /gsd new "Auth Service" "Add JWT authentication to API"
  /gsd task add "Setup database schema"
  /gsd task start plan-001
  /gsd task done plan-001 "Created users table"
  /gsd phase execute
""".strip()


def _handle_gsd_new(args: str) -> str:
    """Handle /gsd new command."""
    from kimi_cli.plans.gsd import get_gsd_manager
    
    parts = args.split(maxsplit=1)
    if len(parts) < 2:
        return "❌ Usage: /gsd new <name> <description>"
    
    name = parts[0]
    description = parts[1]
    
    manager = get_gsd_manager()
    project = manager.init_project(name, description)
    
    return f"""✅ GSD Project created!

📁 Location: {manager.planning_dir}
📋 Project: {project.name}
📝 Description: {project.description}

Next steps:
  1. /gsd status       - View project status
  2. /gsd task add ... - Add tasks
  3. Start working!
"""


def _handle_gsd_task(args: str, manager) -> str:
    """Handle /gsd task commands."""
    from kimi_cli.plans.gsd import GSDPhase
    
    if not manager.has_active_project():
        return "❌ No active GSD project. Use `/gsd new <name> <description>` first."
    
    manager.load_project()
    parts = args.split(maxsplit=1)
    
    if not parts:
        return "❌ Usage: /gsd task <add|start|done> ..."
    
    subcommand = parts[0].lower()
    rest = parts[1] if len(parts) > 1 else ""
    
    # Add task
    if subcommand == "add":
        if not rest:
            return "❌ Usage: /gsd task add <title> [--desc description] [--files file1,file2]"
        
        title = rest
        description = ""
        files = []
        
        # Parse optional args
        if " --desc " in rest:
            title, description = rest.split(" --desc ", 1)
        if " --files " in description:
            description, files_str = description.split(" --files ", 1)
            files = [f.strip() for f in files_str.split(",")]
        elif " --files " in rest:
            title, files_str = rest.split(" --files ", 1)
            files = [f.strip() for f in files_str.split(",")]
        
        phase = GSDPhase[manager.current_project.current_phase.upper()]
        task = manager.add_task(phase, title.strip(), description, files)
        
        return f"✅ Task added: {task.id}\n  Title: {task.title}\n  Phase: {task.phase}"
    
    # Start task
    elif subcommand == "start":
        if not rest:
            return "❌ Usage: /gsd task start <task-id>"
        
        task_id = rest.split()[0]
        task = manager.start_task(task_id)
        
        if task:
            return f"▶️ Started: {task.id} - {task.title}"
        return f"❌ Task not found: {task_id}"
    
    # Complete task
    elif subcommand == "done" or subcommand == "complete":
        if not rest:
            return "❌ Usage: /gsd task done <task-id> [notes]"
        
        parts = rest.split(maxsplit=1)
        task_id = parts[0]
        notes = parts[1] if len(parts) > 1 else ""
        
        task = manager.complete_task(task_id, notes)
        
        if task:
            return f"✅ Completed: {task.id} - {task.title}"
        return f"❌ Task not found: {task_id}"
    
    else:
        return f"❌ Unknown task command: {subcommand}"


def _handle_gsd_phase(args: str, manager) -> str:
    """Handle /gsd phase command."""
    from kimi_cli.plans.gsd import GSDPhase
    
    if not manager.has_active_project():
        return "❌ No active GSD project."
    
    if not args:
        return "❌ Usage: /gsd phase <discuss|research|plan|execute|verify>"
    
    phase_name = args.split()[0].upper()
    
    try:
        phase = GSDPhase[phase_name]
        manager.move_to_phase(phase)
        return f"✅ Moved to phase: {phase.name}"
    except KeyError:
        return f"❌ Unknown phase: {phase_name}. Use: discuss, research, plan, execute, verify"


# Convenience functions for integration
def gsd_status() -> str:
    """Quick status check."""
    from kimi_cli.plans.gsd import get_gsd_manager
    
    manager = get_gsd_manager()
    if not manager.has_active_project():
        return None
    
    manager.load_project()
    project = manager.current_project
    
    total = len(project.tasks)
    done = sum(1 for t in project.tasks if t.status == "done")
    
    return f"[{project.current_phase.upper()}] {done}/{total} tasks"

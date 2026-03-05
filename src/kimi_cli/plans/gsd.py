"""
GSD (Get Shit Done) Integration for Plan Mode.

Provides structured, phased project planning and execution
similar to Claude Code's implementation planning.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from enum import Enum, auto
import os
from pathlib import Path as StdPath
from typing import Optional
from dataclasses import dataclass, field, asdict

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree
from rich import box


class GSDPhase(Enum):
    """GSD Phases for structured execution."""
    DISCUSS = auto()      # Discuss requirements
    RESEARCH = auto()     # Research approach
    PLAN = auto()         # Create detailed plan
    EXECUTE = auto()      # Execute tasks
    VERIFY = auto()       # Verify completion


@dataclass
class GSDTask:
    """Single atomic task in GSD plan."""
    id: str
    phase: str
    title: str
    description: str
    files: list[str] = field(default_factory=list)
    status: str = "pending"  # pending, in_progress, done, blocked
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    completed_at: Optional[str] = None
    notes: str = ""


@dataclass
class GSDProject:
    """GSD Project state."""
    project_id: str
    name: str
    description: str
    current_phase: str = "discuss"
    current_task: Optional[str] = None
    phases_completed: list[str] = field(default_factory=list)
    tasks: list[GSDTask] = field(default_factory=list)
    decisions: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())


class GSDManager:
    """Manages GSD workflow for plan mode."""
    
    def __init__(self, project_path=None):
        self.console = Console()
        # Use standard pathlib.Path, not KaosPath
        if project_path is None:
            self.project_path = StdPath.cwd()
        elif isinstance(project_path, str):
            self.project_path = StdPath(project_path)
        else:
            # If it's a KaosPath, convert to string then to Path
            self.project_path = StdPath(str(project_path))
        self.planning_dir = self.project_path / ".planning"
        self.state_file = self.planning_dir / "STATE.md"
        self.current_project: Optional[GSDProject] = None
        
    def init_project(self, name: str, description: str) -> GSDProject:
        """Initialize new GSD project."""
        # Create .planning structure
        self.planning_dir.mkdir(exist_ok=True)
        (self.planning_dir / "phases").mkdir(exist_ok=True)
        (self.planning_dir / "todos").mkdir(exist_ok=True)
        
        project_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        project = GSDProject(
            project_id=project_id,
            name=name,
            description=description
        )
        
        self.current_project = project
        self._save_project()
        self._create_initial_files()
        
        return project
    
    def _create_initial_files(self):
        """Create initial GSD structure files."""
        if not self.current_project:
            return
            
        # STATE.md
        state_content = f"""# State: {self.current_project.name}

## Current Position
- **Milestone**: v1.0 MVP
- **Phase**: DISCUSS
- **Status**: initializing

## Decisions

## Blockers

## Completed

## Next Actions
1. Discuss requirements and approach
"""
        self.state_file.write_text(state_content)
        
        # PROJECT.md
        project_content = f"""# Project: {self.current_project.name}

## Vision
{self.current_project.description}

## Goals
1. Deliver working solution
2. Follow best practices
3. Maintain code quality

## Success Criteria
- [ ] All phases completed
- [ ] Tests passing
- [ ] Documentation complete
"""
        (self.planning_dir / "PROJECT.md").write_text(project_content)
        
        # REQUIREMENTS.md
        (self.planning_dir / "REQUIREMENTS.md").write_text(f"""# Requirements: {self.current_project.name}

## v1 Requirements

## v2/Future

## Out of Scope
""")
        
        # ROADMAP.md
        (self.planning_dir / "ROADMAP.md").write_text(f"""# Roadmap: {self.current_project.name}

## Phase 1: DISCUSS
- [ ] Clarify requirements
- [ ] Define success criteria
- [ ] Identify constraints

## Phase 2: RESEARCH
- [ ] Investigate approaches
- [ ] Evaluate trade-offs
- [ ] Select technology

## Phase 3: PLAN
- [ ] Break into atomic tasks
- [ ] Define dependencies
- [ ] Estimate effort

## Phase 4: EXECUTE
- [ ] Implement tasks
- [ ] Track progress
- [ ] Handle blockers

## Phase 5: VERIFY
- [ ] Run tests
- [ ] Review code
- [ ] Update docs
""")
    
    def _save_project(self):
        """Save project state."""
        if not self.current_project:
            return
            
        project_file = self.planning_dir / "project.json"
        data = asdict(self.current_project)
        project_file.write_text(json.dumps(data, indent=2, default=str))
    
    def load_project(self) -> Optional[GSDProject]:
        """Load existing GSD project."""
        project_file = self.planning_dir / "project.json"
        if project_file.exists():
            data = json.loads(project_file.read_text())
            self.current_project = GSDProject(**data)
            return self.current_project
        return None
    
    def has_active_project(self) -> bool:
        """Check if there's an active GSD project."""
        return (self.planning_dir / "project.json").exists()
    
    def add_task(self, phase: GSDPhase, title: str, description: str, files: list[str] = None) -> GSDTask:
        """Add new task to project."""
        if not self.current_project:
            raise ValueError("No active project")
        
        task_id = f"{phase.name.lower()}-{len(self.current_project.tasks) + 1:03d}"
        task = GSDTask(
            id=task_id,
            phase=phase.name.lower(),
            title=title,
            description=description,
            files=files or []
        )
        
        self.current_project.tasks.append(task)
        self._save_project()
        return task
    
    def start_task(self, task_id: str) -> Optional[GSDTask]:
        """Mark task as in_progress."""
        if not self.current_project:
            return None
            
        for task in self.current_project.tasks:
            if task.id == task_id:
                task.status = "in_progress"
                self.current_project.current_task = task_id
                self._save_project()
                return task
        return None
    
    def complete_task(self, task_id: str, notes: str = "") -> Optional[GSDTask]:
        """Mark task as done."""
        if not self.current_project:
            return None
            
        for task in self.current_project.tasks:
            if task.id == task_id:
                task.status = "done"
                task.completed_at = datetime.now().isoformat()
                task.notes = notes
                self._save_project()
                return task
        return None
    
    def move_to_phase(self, phase: GSDPhase):
        """Move project to next phase."""
        if not self.current_project:
            return
            
        # Mark current phase complete
        if self.current_project.current_phase:
            self.current_project.phases_completed.append(self.current_project.current_phase)
        
        self.current_project.current_phase = phase.name.lower()
        self.current_project.updated_at = datetime.now().isoformat()
        self._update_state_file()
        self._save_project()
    
    def _update_state_file(self):
        """Update STATE.md with current status."""
        if not self.current_project:
            return
        
        # Count tasks by status
        total = len(self.current_project.tasks)
        done = sum(1 for t in self.current_project.tasks if t.status == "done")
        in_progress = sum(1 for t in self.current_project.tasks if t.status == "in_progress")
        
        content = f"""# State: {self.current_project.name}

## Current Position
- **Milestone**: v1.0 MVP
- **Phase**: {self.current_project.current_phase.upper()}
- **Status**: {done}/{total} tasks complete

## Progress
- Completed: {done}
- In Progress: {in_progress}
- Pending: {total - done - in_progress}

## Decisions
"""
        for decision in self.current_project.decisions:
            content += f"- {decision}\n"
        
        content += "\n## Blockers\n"
        for blocker in self.current_project.blockers:
            content += f"- {blocker}\n"
        
        content += "\n## Completed Phases\n"
        for phase in self.current_project.phases_completed:
            content += f"- {phase.upper()}\n"
        
        self.state_file.write_text(content)
    
    def show_status(self):
        """Display current GSD status."""
        if not self.current_project:
            self.console.print("[yellow]No active GSD project[/yellow]")
            return
        
        project = self.current_project
        
        # Summary panel
        total = len(project.tasks)
        done = sum(1 for t in project.tasks if t.status == "done")
        progress = (done / total * 100) if total > 0 else 0
        
        summary = f"""
[bold]{project.name}[/bold]
{project.description}

Phase: [cyan]{project.current_phase.upper()}[/cyan]
Progress: [green]{done}/{total}[/green] tasks ({progress:.0f}%)
        """.strip()
        
        self.console.print(Panel(summary, title="GSD Project", border_style="blue"))
        
        # Tasks table
        if project.tasks:
            table = Table(show_header=True, box=box.SIMPLE)
            table.add_column("ID", style="dim", width=10)
            table.add_column("Phase", width=10)
            table.add_column("Task")
            table.add_column("Status", width=12)
            
            for task in project.tasks:
                status_color = {
                    "pending": "gray",
                    "in_progress": "yellow",
                    "done": "green",
                    "blocked": "red"
                }.get(task.status, "white")
                
                status_emoji = {
                    "pending": "○",
                    "in_progress": "◐",
                    "done": "●",
                    "blocked": "✗"
                }.get(task.status, "○")
                
                table.add_row(
                    task.id,
                    task.phase,
                    task.title,
                    f"[{status_color}]{status_emoji} {task.status}[/{status_color}]"
                )
            
            self.console.print(table)
    
    def show_tree(self):
        """Show project structure as tree."""
        if not self.current_project:
            return
        
        tree = Tree(f"[bold]{self.current_project.name}[/bold]")
        
        for phase in GSDPhase:
            phase_node = tree.add(f"[cyan]{phase.name}[/cyan]")
            phase_tasks = [t for t in self.current_project.tasks if t.phase == phase.name.lower()]
            
            for task in phase_tasks:
                status_color = "green" if task.status == "done" else "yellow" if task.status == "in_progress" else "white"
                phase_node.add(f"[{status_color}]{task.title}[/{status_color}]")
        
        self.console.print(tree)


def get_gsd_manager(project_path=None):
    """Get GSD manager instance."""
    return GSDManager(project_path)

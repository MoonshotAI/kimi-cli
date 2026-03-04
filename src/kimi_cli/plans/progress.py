"""Rich-based live progress display for plan execution."""

from datetime import datetime

from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.tree import Tree
from rich.text import Text
from rich.align import Align

from kimi_cli.plans.models import PlanExecution, StepExecution


class ExecutionProgressUI:
    """Rich UI for plan execution progress with live updates."""
    
    def __init__(self):
        self.console = Console()
        self.live: Live | None = None
        self.execution: PlanExecution | None = None
    
    def start(self, execution: PlanExecution | None = None):
        """Start live progress display.
        
        Args:
            execution: Initial execution state (can be updated later)
        """
        self.execution = execution
        self.live = Live(
            self._render(),
            refresh_per_second=4,
            console=self.console,
            transient=False,
        )
        self.live.start()
    
    def update(self, execution: PlanExecution | None = None):
        """Update execution state and refresh display.
        
        Args:
            execution: New execution state (optional, uses cached if None)
        """
        if execution:
            self.execution = execution
        if self.live and self.execution:
            self.live.update(self._render())
    
    def stop(self, final_message: str | None = None):
        """Stop live display.
        
        Args:
            final_message: Optional message to show after stopping
        """
        if self.live:
            self.live.stop()
            self.live = None
        if final_message:
            self.console.print(final_message)
    
    def _render(self) -> Panel:
        """Render current execution state as Rich Panel."""
        if not self.execution:
            return Panel("[dim]No execution data[/dim]", title="Plan Execution")
        
        # Build tree view of steps
        tree = Tree(self._get_header_text())
        
        # Group steps by status for better visibility
        running_steps = []
        completed_steps = []
        pending_steps = []
        failed_steps = []
        skipped_steps = []
        
        for step in self.execution.steps:
            if step.status == "running":
                running_steps.append(step)
            elif step.status == "completed":
                completed_steps.append(step)
            elif step.status == "pending":
                pending_steps.append(step)
            elif step.status == "failed":
                failed_steps.append(step)
            elif step.status == "skipped":
                skipped_steps.append(step)
        
        # Add running steps first (most important)
        if running_steps:
            tree.add("[bold yellow]Running:[/bold yellow]")
            for step in running_steps:
                self._add_step_to_tree(tree, step, expanded=True)
        
        # Add completed steps (collapsible)
        if completed_steps:
            completed_branch = tree.add(f"[green]Completed ({len(completed_steps)}):[/green]")
            for step in completed_steps:
                self._add_step_to_tree(completed_branch, step, expanded=False)
        
        # Add failed steps
        if failed_steps:
            failed_branch = tree.add(f"[red]Failed ({len(failed_steps)}):[/red]")
            for step in failed_steps:
                self._add_step_to_tree(failed_branch, step, expanded=True)
        
        # Add skipped steps
        if skipped_steps:
            skipped_branch = tree.add(f"[dim]Skipped ({len(skipped_steps)}):[/dim]")
            for step in skipped_steps:
                self._add_step_to_tree(skipped_branch, step, expanded=False)
        
        # Add pending steps
        if pending_steps:
            pending_branch = tree.add(f"[dim]Pending ({len(pending_steps)}):[/dim]")
            for step in pending_steps[:5]:  # Show first 5
                self._add_step_to_tree(pending_branch, step, expanded=False)
            if len(pending_steps) > 5:
                pending_branch.add(f"[dim]... and {len(pending_steps) - 5} more[/dim]")
        
        # Overall progress
        completed, total = self.execution.get_progress()
        percentage = int((completed / total * 100)) if total > 0 else 0
        duration = self.execution.get_duration()
        
        progress_text = f"Progress: {completed}/{total} steps ({percentage}%) | Duration: {self._format_duration(duration)}"
        
        return Panel(
            tree,
            title=f"[bold cyan]📋 Plan Execution[/bold cyan]",
            subtitle=f"[dim]{progress_text}[/dim]",
            border_style="cyan",
            padding=(1, 2),
        )
    
    def _get_header_text(self) -> str:
        """Get header text with plan status."""
        if not self.execution:
            return "[dim]No plan[/dim]"
        
        status_colors = {
            "running": "yellow",
            "completed": "green",
            "failed": "red",
            "partial": "yellow",
        }
        color = status_colors.get(self.execution.overall_status, "white")
        return f"[bold {color}]{self.execution.plan_id}[/bold {color}] [{self.execution.overall_status.upper()}]"
    
    def _add_step_to_tree(self, tree: Tree, step: StepExecution, expanded: bool = False):
        """Add a step to the tree with appropriate formatting."""
        icon = self._get_status_icon(step.status)
        duration = f"[{self._format_duration(step.duration_seconds)}]" if step.duration_seconds > 0 else ""
        
        label = f"{icon} {step.step_id} {duration}"
        branch = tree.add(label)
        
        if expanded or step.status in ("failed", "running"):
            # Show details
            if step.output_summary:
                branch.add(f"[dim]{step.output_summary[:80]}[/dim]")
            
            if step.files_modified:
                files_str = ", ".join(step.files_modified[:3])
                if len(step.files_modified) > 3:
                    files_str += f" [dim]+{len(step.files_modified) - 3} more[/dim]"
                branch.add(f"[dim]Files: {files_str}[/dim]")
            
            if step.lines_added or step.lines_removed:
                changes = f"[+{step.lines_added}/-{step.lines_removed}]"
                branch.add(f"[dim]Changes: {changes}[/dim]")
            
            if step.error_message and step.status == "failed":
                error_text = step.error_message[:100] + "..." if len(step.error_message) > 100 else step.error_message
                branch.add(f"[red]Error: {error_text}[/red]")
    
    def _get_status_icon(self, status: str) -> str:
        """Get icon for step status."""
        icons = {
            "pending": "[dim]○[/dim]",
            "running": "[yellow]▶[/yellow]",
            "completed": "[green]✓[/green]",
            "failed": "[red]✗[/red]",
            "skipped": "[dim]⊘[/dim]",
        }
        return icons.get(status, "[dim]?[/dim]")
    
    def _format_duration(self, seconds: float) -> str:
        """Format duration in human-readable form."""
        if seconds < 60:
            return f"{int(seconds)}s"
        elif seconds < 3600:
            minutes = int(seconds / 60)
            secs = int(seconds % 60)
            return f"{minutes}m {secs}s"
        else:
            hours = int(seconds / 3600)
            minutes = int((seconds % 3600) / 60)
            return f"{hours}h {minutes}m"


class ExecutionProgressListener:
    """Listener that updates ProgressUI on executor events."""
    
    def __init__(self, ui: ExecutionProgressUI):
        self.ui = ui
    
    def on_step_start(self, step_exec: StepExecution):
        """Called when step starts."""
        self.ui.update()
    
    def on_step_complete(self, step_exec: StepExecution):
        """Called when step completes."""
        self.ui.update()
    
    def on_step_failed(self, step_exec: StepExecution):
        """Called when step fails."""
        self.ui.update()

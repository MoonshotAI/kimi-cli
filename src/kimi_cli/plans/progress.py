"""Rich-based live progress display for plan execution."""

import time
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
    
    def __init__(self, throttle: bool = False):
        """Initialize progress UI.
        
        Args:
            throttle: If True, reduce update frequency for large plans
        """
        self.console = Console()
        self.live: Live | None = None
        self.execution: PlanExecution | None = None
        
        # Throttling configuration
        self.throttle = throttle
        self._last_update = 0.0
        self._update_interval = 0.5 if throttle else 0.1  # Slower updates for large plans
        self._pending_update = False
    
    def start(self, execution: PlanExecution | None = None):
        """Start live progress display.
        
        Args:
            execution: Initial execution state (can be updated later)
        """
        self.execution = execution
        self._last_update = time.time()
        self.live = Live(
            self._render(),
            refresh_per_second=4 if not self.throttle else 2,
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
        
        if not self.live or not self.execution:
            return
        
        now = time.time()
        
        # Check throttle
        if now - self._last_update < self._update_interval:
            self._pending_update = True
            return  # Skip update
        
        self._last_update = now
        self._pending_update = False
        self._render_and_update()
    
    def force_update(self):
        """Force immediate update regardless of throttle."""
        if self.live and self.execution:
            self._last_update = time.time()
            self._pending_update = False
            self._render_and_update()
    
    def _render_and_update(self):
        """Render and update the live display."""
        try:
            self.live.update(self._render())
        except Exception:
            # Don't let rendering errors break execution
            pass
    
    def stop(self, final_message: str | None = None):
        """Stop live display.
        
        Args:
            final_message: Optional message to show after stopping
        """
        # Force final update if pending
        if self._pending_update and self.live:
            self._render_and_update()
        
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
            # Show fewer completed steps when throttled
            max_completed = 3 if self.throttle else 10
            for step in completed_steps[-max_completed:]:  # Show most recent
                self._add_step_to_tree(completed_branch, step, expanded=False)
            if len(completed_steps) > max_completed:
                completed_branch.add(f"[dim]... and {len(completed_steps) - max_completed} more[/dim]")
        
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
            max_pending = 3 if self.throttle else 5
            for step in pending_steps[:max_pending]:
                self._add_step_to_tree(pending_branch, step, expanded=False)
            if len(pending_steps) > max_pending:
                pending_branch.add(f"[dim]... and {len(pending_steps) - max_pending} more[/dim]")
        
        # Overall progress
        completed, total = self.execution.get_progress()
        percentage = int((completed / total * 100)) if total > 0 else 0
        duration = self.execution.get_duration()
        
        progress_text = f"Progress: {completed}/{total} steps ({percentage}%) | Duration: {self._format_duration(duration)}"
        
        # Add throttle indicator
        if self.throttle:
            progress_text += " [dim](throttled)[/dim]"
        
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
        
        # Skip details when throttled unless expanded is required
        show_details = expanded or not self.throttle
        
        if show_details or step.status in ("failed", "running"):
            # Show details
            if step.output_summary:
                summary = step.output_summary[:80] if self.throttle else step.output_summary[:120]
                branch.add(f"[dim]{summary}[/dim]")
            
            if step.files_modified:
                max_files = 2 if self.throttle else 3
                files_str = ", ".join(step.files_modified[:max_files])
                if len(step.files_modified) > max_files:
                    files_str += f" [dim]+{len(step.files_modified) - max_files} more[/dim]"
                branch.add(f"[dim]Files: {files_str}[/dim]")
            
            if step.lines_added or step.lines_removed:
                changes = f"[+{step.lines_added}/-{step.lines_removed}]"
                branch.add(f"[dim]Changes: {changes}[/dim]")
            
            if step.error_message and step.status == "failed":
                error_text = step.error_message[:80] + "..." if len(step.error_message) > 80 else step.error_message
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
    
    def on_retry(self, step_id: str, attempt: int, reason: str):
        """Called when step is being retried."""
        # Force update on retry to show retry status
        self.ui.force_update()

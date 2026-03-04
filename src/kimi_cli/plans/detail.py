"""
Detailed plan view shown before execution with confirmation.

This module provides a rich-based detailed view of a selected plan option,
displaying all details and asking for user confirmation before execution.
"""

import sys
import tty
import termios

from rich.console import Console
from rich.panel import Panel
from rich.text import Text
from rich.align import Align
from rich import box

from kimi_cli.plans.models import Plan


def getch() -> str:
    """Get single character without pressing Enter.
    
    Returns:
        Single character string
    """
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        return sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


class PlanDetailView:
    """Show detailed view of selected plan option with confirmation."""
    
    def __init__(self):
        self.console = Console()
    
    def show(self, plan: Plan, option_index: int) -> bool:
        """Show detailed view and ask for confirmation.
        
        Args:
            plan: The plan containing options
            option_index: Index of selected option (0-based)
            
        Returns:
            bool: True if user confirms (y), False to go back (n)
        """
        option = plan.options[option_index]
        
        # Build detailed content
        content = self._build_content(plan, option)
        
        # Show panel
        panel = Panel(
            content,
            title="[bold cyan]Plan Details[/bold cyan]",
            subtitle="[dim]Execute this plan? (y/n)[/dim]",
            box=box.ROUNDED,
            border_style="cyan"
        )
        
        self.console.print(panel)
        
        # Get confirmation
        return self._confirm()
    
    def _build_content(self, plan: Plan, option) -> Text:
        """Build detailed content for the panel.
        
        Args:
            plan: The plan containing metadata
            option: The selected plan option
            
        Returns:
            Rich Text object with formatted content
        """
        lines = []
        
        # Option title with index (bold)
        title_line = Text()
        title_line.append(f"[{option.id}] ", style="bold cyan")
        title_line.append(option.title, style="bold")
        lines.append(title_line)
        lines.append(Text())  # Empty line
        
        # Description section
        lines.append(Text("Description:", style="bold"))
        description_lines = option.description.split('\n')
        for desc_line in description_lines:
            lines.append(Text(f"  {desc_line}", style="default"))
        lines.append(Text())  # Empty line
        
        # Pros section with ✓ marker
        if option.pros:
            lines.append(Text("Pros:", style="bold green"))
            for pro in option.pros:
                pro_line = Text()
                pro_line.append("  ✓ ", style="green")
                pro_line.append(pro, style="default")
                lines.append(pro_line)
            lines.append(Text())  # Empty line
        
        # Cons section with ✗ marker
        if option.cons:
            lines.append(Text("Cons:", style="bold red"))
            for con in option.cons:
                con_line = Text()
                con_line.append("  ✗ ", style="red")
                con_line.append(con, style="default")
                lines.append(con_line)
            lines.append(Text())  # Empty line
        
        # Separator line
        separator = Text("─" * 50, style="dim")
        lines.append(separator)
        lines.append(Text())  # Empty line
        
        # Metadata line (Estimated time and Approach type)
        meta_parts = []
        if option.estimated_time:
            meta_parts.append(f"Estimated: {option.estimated_time}")
        meta_parts.append(f"Approach: {option.approach_type}")
        meta_line = Text("  |  ".join(meta_parts), style="cyan")
        lines.append(meta_line)
        
        # Original query (dim)
        query_line = Text()
        query_line.append("Query: ", style="dim")
        query_line.append(plan.query, style="dim")
        lines.append(query_line)
        
        # Combine all lines
        result = Text()
        for i, line in enumerate(lines):
            if i > 0:
                result.append("\n")
            result.append(line)
        
        return result
    
    def _confirm(self) -> bool:
        """Get user confirmation.
        
        Returns:
            bool: True for 'y', False for 'n' or Ctrl+C
        """
        while True:
            try:
                char = getch()
                
                # Handle Ctrl+C
                if char == '\x03':
                    self.console.print()
                    return False
                
                # Handle 'y' or 'Y'
                if char.lower() == 'y':
                    self.console.print()
                    return True
                
                # Handle 'n' or 'N'
                if char.lower() == 'n':
                    self.console.print()
                    return False
                
                # Ignore other characters and continue looping
                
            except (KeyboardInterrupt, EOFError):
                self.console.print()
                return False

"""
Interactive menu for plan selection with arrow key navigation.

This module provides an interactive menu for selecting plan options
using keyboard navigation (arrow keys, Enter, q to cancel).
"""

import sys
import tty
import termios
from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich import box

from kimi_cli.plans.models import Plan, PlanOption


def getch() -> str:
    """Get single character without pressing Enter.
    
    Returns:
        Single character string (may include escape sequences for special keys)
    """
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        return sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


class InteractivePlanMenu:
    """Interactive menu for plan selection with arrow keys."""
    
    def __init__(self):
        self.console = Console()
        self.selected = 0
    
    def show(self, plan: Plan) -> int | None:
        """Show interactive menu and return selected option index.
        
        Uses arrow keys (↑/↓) to navigate, Enter to select, 'q' to cancel.
        
        Args:
            plan: Plan with options to display
            
        Returns:
            int: Selected option index (0-based)
            None: User cancelled (pressed 'q' or Ctrl+C)
        """
        self.selected = 0
        
        # Clear screen and show initial menu
        self.console.clear()
        
        while True:
            # Render and display menu
            self.console.print(self._render(plan))
            
            try:
                action = self._handle_input()
            except KeyboardInterrupt:
                self.console.clear()
                return None
            
            if action == "up":
                self.selected = (self.selected - 1) % len(plan.options)
            elif action == "down":
                self.selected = (self.selected + 1) % len(plan.options)
            elif action == "select":
                self.console.clear()
                return self.selected
            elif action == "cancel":
                self.console.clear()
                return None
            
            # Clear screen for next render
            self.console.clear()
    
    def _render(self, plan: Plan) -> Panel:
        """Render menu table with current selection highlighted.
        
        Args:
            plan: Plan with options to display
            
        Returns:
            Rich Panel containing the formatted menu
        """
        # Create main table for options
        table = Table(
            show_header=False,
            show_edge=False,
            show_lines=False,
            padding=(0, 1),
            box=None,
        )
        table.add_column("marker", width=3, style="bold")
        table.add_column("content", ratio=1)
        
        for i, option in enumerate(plan.options):
            is_selected = i == self.selected
            
            # Marker: '>' for selected, ' ' for others
            marker = ">" if is_selected else " "
            marker_style = "bold cyan" if is_selected else "dim"
            
            # Format the option content
            content = self._format_option(option, is_selected)
            
            table.add_row(
                Text(marker, style=marker_style),
                content
            )
        
        # Add help text at the bottom
        help_text = Text(
            "\n↑/↓ to navigate • Enter to select • q to cancel",
            style="dim",
            justify="center"
        )
        
        # Create panel with title - combine table and help
        from rich.console import Group
        content = Group(table, help_text)
        
        panel = Panel(
            content,
            title="[bold blue]Plan Selection[/bold blue]",
            title_align="center",
            border_style="blue",
            box=box.ROUNDED,
            padding=(1, 2)
        )
        
        return panel
    
    def _format_option(self, option: PlanOption, is_selected: bool) -> Text:
        """Format a single option for display.
        
        Args:
            option: Plan option to format
            is_selected: Whether this option is currently selected
            
        Returns:
            Rich Text object
        """
        # Title with number
        title_style = "bold cyan" if is_selected else "bold white"
        title = Text.assemble(
            (f"[{option.id}] ", "dim"),
            (option.title, title_style)
        )
        
        # Description (truncated)
        desc_text = option.description[:200]
        if len(option.description) > 200:
            desc_text += "..."
        description = Text(desc_text, style="dim" if not is_selected else "default")
        
        # Meta info (time, approach_type, pros/cons count)
        meta_parts = []
        if option.estimated_time:
            meta_parts.append(f"⏱ {option.estimated_time}")
        if option.approach_type:
            approach_emoji = {"quick": "⚡", "proper": "✓", "hybrid": "⚖"}.get(option.approach_type, "•")
            meta_parts.append(f"{approach_emoji} {option.approach_type.title()}")
        if option.pros:
            meta_parts.append(f"✓ {len(option.pros)} pros")
        if option.cons:
            meta_parts.append(f"✗ {len(option.cons)} cons")
        
        meta = Text("  ").append(Text("  ").join([Text(m, style="dim") for m in meta_parts]))
        
        # Combine all parts
        result = Text.assemble(
            title,
            "\n",
            description,
            "\n",
            meta
        )
        
        return result
    
    def _handle_input(self) -> str:
        """Handle single keypress and return action.
        
        Returns:
            'up', 'down', 'select', or 'cancel'
        """
        char = getch()
        
        # Handle escape sequences (arrow keys)
        if char == '\x1b':
            seq = getch()
            if seq == '[':
                arrow = getch()
                if arrow == 'A':  # Up arrow
                    return "up"
                elif arrow == 'B':  # Down arrow
                    return "down"
        
        # Handle single character inputs
        if char in ('\r', '\n', '\x0d'):  # Enter (various representations)
            return "select"
        elif char in ('q', 'Q', '\x03'):  # q, Q, or Ctrl+C
            return "cancel"
        elif char == 'k' or char == 'K':  # vim-style up
            return "up"
        elif char == 'j' or char == 'J':  # vim-style down
            return "down"
        
        return "unknown"


def select_plan_option(plan: Plan) -> Optional[int]:
    """Convenience function to show interactive menu and return selection.
    
    Args:
        plan: Plan with options to display
        
    Returns:
        int: Selected option index (0-based)
        None: User cancelled
    """
    menu = InteractivePlanMenu()
    return menu.show(plan)

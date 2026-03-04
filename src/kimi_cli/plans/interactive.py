"""
Interactive menu for plan selection with arrow key navigation.

This module provides a rich-based interactive menu for selecting plan options
using keyboard navigation (arrow keys, Enter, q to cancel).
"""

import sys
import tty
import termios
from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.live import Live
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
        
        with Live(
            self._render(plan),
            console=self.console,
            refresh_per_second=30,
            auto_refresh=False
        ) as live:
            while True:
                live.update(self._render(plan))
                
                try:
                    action = self._handle_input()
                except KeyboardInterrupt:
                    return None
                
                if action == "up":
                    self.selected = (self.selected - 1) % len(plan.options)
                elif action == "down":
                    self.selected = (self.selected + 1) % len(plan.options)
                elif action == "select":
                    return self.selected
                elif action == "cancel":
                    return None
    
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
            padding=(0, 0),
            box=None,
        )
        table.add_column("marker", width=2, style="bold")
        table.add_column("content", ratio=1)
        
        for i, option in enumerate(plan.options):
            is_selected = i == self.selected
            row_style = self._get_option_style(option, is_selected)
            
            # Marker: '>' for selected, ' ' for others
            marker = ">" if is_selected else " "
            
            # Format the option content
            content = self._format_option(option, is_selected)
            
            table.add_row(
                Text(marker, style=row_style),
                content
            )
        
        # Add help text at the bottom
        help_text = Text(
            "↑/↓ to navigate • Enter to select • q to cancel",
            style="dim",
            justify="center"
        )
        
        # Combine table and help text
        content = Text.assemble(
            table,
            "\n\n",
            help_text
        )
        
        # Create panel with title
        panel = Panel(
            content,
            title="Select Implementation Approach",
            title_align="left",
            border_style="blue",
            box=box.ROUNDED,
            padding=(1, 2)
        )
        
        return panel
    
    def _get_option_style(self, option: PlanOption, is_selected: bool) -> str:
        """Get the style for an option based on selection state and approach type.
        
        Args:
            option: The plan option
            is_selected: Whether this option is currently selected
            
        Returns:
            Rich style string
        """
        if is_selected:
            return "bold green"
        return "default"
    
    def _format_option(self, option: PlanOption, is_selected: bool) -> Text:
        """Format a plan option for display.
        
        Args:
            option: The plan option to format
            is_selected: Whether this option is currently selected
            
        Returns:
            Rich Text object with formatted content
        """
        style = "bold green" if is_selected else "default"
        
        # Title line: [id] Title
        title = Text.assemble(
            (f"[{option.id}] ", style),
            (option.title, f"bold {style}" if is_selected else "bold")
        )
        
        # Description line (indented)
        description = Text(f"  {option.description}", style="dim")
        
        # Pros/Cons preview line
        preview_parts = []
        
        # Add time estimate if available
        if option.estimated_time:
            preview_parts.append((f"⏱ {option.estimated_time}", "cyan"))
        
        # Add approach type indicator
        type_indicators = {
            "quick": ("⚡ Quick", "yellow"),
            "proper": ("✓ Proper", "green"),
            "hybrid": ("⚖ Hybrid", "blue")
        }
        if option.approach_type in type_indicators:
            indicator, color = type_indicators[option.approach_type]
            preview_parts.append((indicator, color))
        
        # Add pros preview (first pro or count)
        if option.pros:
            pros_text = f"✓ {option.pros[0]}" if len(option.pros) == 1 else f"✓ {len(option.pros)} pros"
            preview_parts.append((pros_text, "green"))
        
        # Add cons preview (first con or count)
        if option.cons:
            cons_text = f"✗ {option.cons[0]}" if len(option.cons) == 1 else f"✗ {len(option.cons)} cons"
            preview_parts.append((cons_text, "red"))
        
        # Build preview line
        preview_spans = []
        for i, (text, color) in enumerate(preview_parts):
            if i > 0:
                preview_spans.append(("  ", "default"))
            preview_spans.append((text, color))
        
        preview = Text("  ")
        for text, color in preview_spans:
            preview.append(text, style=color)
        
        # Combine all parts
        result = Text.assemble(
            title,
            "\n",
            description,
            "\n",
            preview
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

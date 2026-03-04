"""
UI components for the Plans System.

This module provides rendering functionality for displaying plans
as interactive menus with box-drawing characters.
"""

from kimi_cli.plans.models import Plan, PlanOption


class PlanMenuRenderer:
    """Renders plan options as an interactive menu with box-drawing characters."""

    WIDTH = 60  # Total width of the box
    INNER_WIDTH = WIDTH - 4  # Width inside the box borders and padding

    # Box drawing characters
    TOP_LEFT = "┌"
    TOP_RIGHT = "┐"
    BOTTOM_LEFT = "└"
    BOTTOM_RIGHT = "┘"
    HORIZONTAL = "─"
    VERTICAL = "│"

    # Icons
    CHECK = "✓"
    CROSS = "✗"

    def render(self, plan: Plan) -> str:
        """Render plan options as interactive menu.

        Expected output format:
        ┌─ Plan Selection ──────────────────────────────────────┐
        │                                                       │
        │ Query: Add validation to user input                   │
        │                                                       │
        │ [1] Quick Fix                                         │
        │     Add inline validation checks                      │
        │     ✓ 5 min        ✗ Hard to maintain                 │
        │                                                       │
        │ [2] Extract Validator Class                           │
        │     Create dedicated validation class                 │
        │     ✓ Clean code   ✗ 30 min                           │
        │                                                       │
        │ [3] Hybrid Approach                                   │
        │     Use library + custom checks                       │
        │     ✓ Balanced     ✗ Dependencies                     │
        │                                                       │
        └───────────────────────────────────────────────────────┘
        Choose (1-3 or c to cancel):
        """
        lines: list[str] = []

        # Header
        lines.append(self._header("Plan Selection"))

        # Empty line after header
        lines.append(self._box_line())

        # Query line
        query_text = f"Query: {plan.query}"
        lines.append(self._box_line(query_text))

        # Empty line after query
        lines.append(self._box_line())

        # Options
        for i, option in enumerate(plan.options):
            option_lines = self._format_option(option)
            lines.extend(option_lines)
            # Add empty line between options (but not after the last one)
            if i < len(plan.options) - 1:
                lines.append(self._box_line())

        # Empty line before footer
        lines.append(self._box_line())

        # Footer
        lines.append(self._footer())

        # Prompt (outside the box)
        max_option = len(plan.options)
        prompt = f"Choose (1-{max_option} or c to cancel): "
        lines.append(prompt)

        return "\n".join(lines)

    def _format_option(self, option: PlanOption) -> list[str]:
        """Format single option into lines."""
        lines: list[str] = []

        # Title line: "[1] Quick Fix"
        title = f"[{option.id}] {option.title}"
        lines.append(self._box_line(title))

        # Description line (indented)
        desc = f"    {option.description}"
        lines.append(self._box_line(desc))

        # Pros and cons line
        # Format: "✓ 5 min        ✗ Hard to maintain"
        # or:     "✓ Clean code   ✗ 30 min"
        pros_cons_parts: list[str] = []

        # Add pros (first pro or time estimate)
        if option.estimated_time:
            pros_cons_parts.append(f"{self.CHECK} {option.estimated_time}")
        elif option.pros:
            pros_cons_parts.append(f"{self.CHECK} {option.pros[0]}")

        # Add cons (first con, or if time was used for pros, use first con)
        if option.cons:
            pros_cons_parts.append(f"{self.CROSS} {option.cons[0]}")
        elif option.pros and len(option.pros) > 1 and option.estimated_time:
            # If we used estimated_time as pro, show first pro as additional info
            pros_cons_parts.append(f"{self.CHECK} {option.pros[0]}")

        if pros_cons_parts:
            # Space out pros and cons with enough gap
            pros_cons_line = f"    {pros_cons_parts[0]:<22} {pros_cons_parts[1] if len(pros_cons_parts) > 1 else ''}"
            lines.append(self._box_line(pros_cons_line))

        return lines

    def _truncate(self, text: str, max_width: int) -> str:
        """Truncate text to fit within max_width, adding ellipsis if needed."""
        if len(text) <= max_width:
            return text
        return text[: max_width - 3] + "..."

    def _box_line(self, content: str = "", center: bool = False) -> str:
        """Create boxed line: │ content │"""
        if center:
            # Center the content
            padding_total = self.INNER_WIDTH - len(content)
            left_padding = padding_total // 2
            right_padding = padding_total - left_padding
            padded = " " * left_padding + content + " " * right_padding
        else:
            # Left-align and pad
            truncated = self._truncate(content, self.INNER_WIDTH)
            padded = truncated.ljust(self.INNER_WIDTH)

        return f"{self.VERTICAL} {padded} {self.VERTICAL}"

    def _header(self, title: str) -> str:
        """Create header line: ┌─ Title ───────────┐"""
        # Format: "┌─ Title ──────────────────────────────┐"
        prefix = f"{self.TOP_LEFT}{self.HORIZONTAL} {title} "
        remaining = self.WIDTH - len(prefix) - 1  # -1 for right corner
        return f"{prefix}{self.HORIZONTAL * remaining}{self.TOP_RIGHT}"

    def _footer(self) -> str:
        """Create footer line: └────────────────────┘"""
        return f"{self.BOTTOM_LEFT}{self.HORIZONTAL * (self.WIDTH - 2)}{self.BOTTOM_RIGHT}"

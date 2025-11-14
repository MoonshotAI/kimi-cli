import difflib
from collections.abc import Iterator
from pathlib import Path
from typing import NamedTuple


class FileDiff(NamedTuple):
    """Represents a file diff with before and after content."""

    path: str
    before_content: str | None
    after_content: str
    is_new_file: bool = False

    def should_show_diff(self) -> bool:
        """Determine if the diff should be shown (i.e., there are changes)."""
        if self.is_new_file:
            return True
        if self.before_content is None:
            return True
        return self.before_content != self.after_content


def generate_text_diff(before: str, after: str, context_lines: int = 3) -> str:
    """Generate a unified diff between two text contents.

    Args:
        before: The original content
        after: The new content
        context_lines: Number of context lines to show around changes

    Returns:
        Unified diff string
    """
    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)

    diff = difflib.unified_diff(
        before_lines,
        after_lines,
        fromfile="before",
        tofile="after",
        n=context_lines,
    )

    return colorize_diff(diff)


def colorize_diff(diff_text: Iterator[str]) -> str:
    """Add Rich markup to colorize diff output.

    Args:
        diff_text: Plain unified diff text

    Returns:
        Diff text with Rich markup for colors (green for additions, red for deletions)
    """
    colored_lines: list[str] = []

    for line in diff_text:
        # Remove trailing newlines for display
        line = line.rstrip("\n")

        if line.startswith("+") and not line.startswith("+++"):
            # Addition line - green
            colored_lines.append(f"[green]{line}[/green]")
        elif line.startswith("-") and not line.startswith("---"):
            # Deletion line - red
            colored_lines.append(f"[red]{line}[/red]")
        elif line.startswith("@@"):
            # Hunk header - cyan
            colored_lines.append(f"[cyan]{line}[/cyan]")
        elif line.startswith("---") or line.startswith("+++"):
            # File headers - bold
            colored_lines.append(f"[bold]{line}[/bold]")
        else:
            # Context line - no color
            colored_lines.append(line)

    return "\n".join(colored_lines)


def generate_file_diff(
    path: Path,
    new_content: str,
    is_new_file: bool = False,
    original_content: str | None = None,
    append: bool = False,
) -> FileDiff:
    """Generate a file diff for a proposed change.

    Args:
        path: Path to the file
        new_content: The new content that would be written
        is_new_file: Whether this is a new file creation
        original_content: The original content (if None, will try to read from file)

    Returns:
        FileDiff object containing the diff information
    """
    if is_new_file:
        return FileDiff(
            path=str(path),
            before_content=None,
            after_content=new_content,
            is_new_file=True,
        )

    # Try to read existing content if not provided
    if original_content is None:
        try:
            with open(path, encoding="utf-8") as f:
                original_content = f.read()
        except (FileNotFoundError, UnicodeDecodeError, PermissionError):
            # Treat as new file if it doesn't exist or can't be read as text
            original_content = None
            is_new_file = True

    if append and original_content is not None:
        new_content = original_content + new_content

    return FileDiff(
        path=str(path),
        before_content=original_content,
        after_content=new_content,
        is_new_file=is_new_file,
    )


def format_diff_for_display(diff: FileDiff, max_lines: int = 30) -> str:
    """Format a file diff for display in the approval panel.

    Args:
        diff: The FileDiff to format
        max_lines: Maximum number of diff lines to show before truncating

    Returns:
        Formatted diff string suitable for display
    """
    if diff.is_new_file:
        content = truncate_content(diff.after_content, max_lines)
        return f"New file: {diff.path}\n\n{content}"

    if diff.before_content is None:
        return f"Cannot read existing file: {diff.path}"

    if diff.before_content == diff.after_content:
        return f"No changes to file: {diff.path}"

    # Generate unified diff (already colorized)
    diff_text = generate_text_diff(diff.before_content, diff.after_content)

    # Truncate if too long

    return f"Changed file: {diff.path}\n\n{truncate_content(diff_text, max_lines)}"


def truncate_content(content: str, max_lines: int) -> str:
    """Truncate content to a maximum number of lines.

    Args:
        content: The content to truncate
        max_lines: Maximum number of lines to keep

    Returns:
        Truncated content string
    """
    lines = content.splitlines()
    if len(lines) > max_lines:
        truncated_lines = lines[:max_lines]
        truncated_lines.append(f"... ({len(lines) - max_lines} more lines)")
        return "\n".join(truncated_lines)
    return content

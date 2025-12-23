from __future__ import annotations

from kosong.tooling import DisplayBlock

__all__ = [
    "DisplayBlock",  # re-export for convenience
    "DiffDisplayBlock",
]


class DiffDisplayBlock(DisplayBlock):
    """Display block describing a file diff."""

    type: str = "diff"
    path: str
    old_text: str
    new_text: str

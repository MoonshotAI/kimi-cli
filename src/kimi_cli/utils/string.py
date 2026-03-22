from __future__ import annotations

import random
import re
import string

_NEWLINE_RE = re.compile(r"[\r\n]+")


def shorten_middle(text: str, width: int, remove_newline: bool = True) -> str:
    """Shorten the text by inserting ellipsis in the middle."""
    if len(text) <= width:
        return text
    if remove_newline:
        text = _NEWLINE_RE.sub(" ", text)
    return text[: width // 2] + "..." + text[-width // 2 :]


def shorten_path(path: str, width: int = 50) -> str:
    """
    Smart path shortening that preserves the filename and parent directory.
    
    For paths, we prioritize showing:
    1. The filename (always visible)
    2. The parent directory name
    3. Then truncate from the middle of the path prefix
    
    Examples:
      - /home/user/very/long/path/to/file.txt -> ~/.../path/to/file.txt
      - /a/b/c/d/e/f/g/h/i/j/k/l/file.txt -> /a/.../k/l/file.txt
      - short/path/file.txt -> short/path/file.txt (no change)
    """
    if len(path) <= width:
        return path
    
    # Split path into components
    import os
    parts = path.split('/')
    
    # If very few parts, fall back to middle shortening
    if len(parts) <= 3:
        return shorten_middle(path, width)
    
    # Always keep filename and its parent
    filename = parts[-1]
    parent = parts[-2] if len(parts) >= 2 else ""
    
    # Build from the end: .../parent/filename
    suffix = f"/{parent}/{filename}" if parent else f"/{filename}"
    
    # Reserve space for prefix + ellipsis
    available = width - len(suffix) - 4  # 4 for ".../"
    
    if available <= 5:
        # Not enough space, just show .../filename
        return f".../{filename}"[:width]
    
    # Build prefix from the start
    prefix_parts = []
    current_len = 0
    for part in parts[:-2]:  # Exclude parent and filename
        if current_len + len(part) + 1 <= available:
            prefix_parts.append(part)
            current_len += len(part) + 1
        else:
            break
    
    if prefix_parts:
        prefix = '/'.join(prefix_parts)
        return f"{prefix}/...{suffix}"
    else:
        return f"...{suffix}"


def random_string(length: int = 8) -> str:
    """Generate a random string of fixed length."""
    letters = string.ascii_lowercase
    return "".join(random.choice(letters) for _ in range(length))

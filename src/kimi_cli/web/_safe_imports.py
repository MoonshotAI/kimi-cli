from __future__ import annotations

import os
import sys
from pathlib import Path


def remove_current_workdir_from_sys_path() -> None:
    """Avoid importing user project files as third-party dependencies."""

    try:
        cwd = Path.cwd().resolve()
    except OSError:
        return

    filtered: list[str] = []
    for entry in sys.path:
        candidate = Path(entry or os.curdir)
        try:
            if candidate.resolve() == cwd:
                continue
        except OSError:
            pass
        filtered.append(entry)
    sys.path[:] = filtered


remove_current_workdir_from_sys_path()

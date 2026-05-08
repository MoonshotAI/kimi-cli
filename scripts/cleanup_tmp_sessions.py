#!/usr/bin/env python3
"""Clean up .kimi sessions whose workdir is under a temporary directory.

This script handles two cases:
  1. Entries in kimi.json whose path is a tmp directory -> remove entry + session dir.
  2. Orphan session directories on disk that have no matching kimi.json entry
     (e.g. leftover from previously cleaned entries or tests).

Temporary directories are detected by checking if the path starts with
common tmp prefixes: /tmp, /private/tmp, /var/folders, /private/var/folders.

Usage:
    python scripts/cleanup_tmp_sessions.py          # dry-run (default)
    python scripts/cleanup_tmp_sessions.py --apply   # actually delete
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from hashlib import md5
from pathlib import Path

KIMI_DIR = Path.home() / ".kimi"
METADATA_FILE = KIMI_DIR / "kimi.json"
SESSIONS_DIR = KIMI_DIR / "sessions"

TMP_PREFIXES = (
    "/tmp/",
    "/private/tmp/",
    "/var/folders/",
    "/private/var/folders/",
)


def is_tmp_path(path: str) -> bool:
    """Return True if *path* looks like a temporary directory."""
    if path in ("/tmp", "/private/tmp"):
        return True
    return any(path.startswith(p) for p in TMP_PREFIXES)


def work_dir_hash(path: str, kaos: str = "local") -> str:
    h = md5(path.encode("utf-8")).hexdigest()
    return h if kaos == "local" else f"{kaos}_{h}"


def dir_total_size(d: Path) -> int:
    return sum(f.stat().st_size for f in d.rglob("*") if f.is_file())


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--apply", action="store_true", help="Actually delete (default is dry-run)")
    args = parser.parse_args()

    if not METADATA_FILE.exists():
        print(f"Metadata file not found: {METADATA_FILE}")
        sys.exit(1)

    with open(METADATA_FILE, encoding="utf-8") as f:
        metadata = json.load(f)

    work_dirs: list[dict] = metadata.get("work_dirs", [])

    # --- Phase 1: tmp entries in kimi.json ---
    tmp_entries: list[dict] = []
    keep_entries: list[dict] = []
    keep_hashes: set[str] = set()
    for wd in work_dirs:
        if is_tmp_path(wd.get("path", "")):
            tmp_entries.append(wd)
        else:
            keep_entries.append(wd)
            keep_hashes.add(work_dir_hash(wd["path"], wd.get("kaos", "local")))

    tmp_dirs: list[Path] = []
    for wd in tmp_entries:
        h = work_dir_hash(wd["path"], wd.get("kaos", "local"))
        session_dir = SESSIONS_DIR / h
        if session_dir.is_dir():
            tmp_dirs.append(session_dir)

    # --- Phase 2: orphan directories (on disk but not in kimi.json) ---
    orphan_dirs: list[Path] = []
    if SESSIONS_DIR.is_dir():
        for d in SESSIONS_DIR.iterdir():
            if d.is_dir() and d.name not in keep_hashes and d not in tmp_dirs:
                orphan_dirs.append(d)

    all_dirs_to_remove = tmp_dirs + orphan_dirs
    if not all_dirs_to_remove and not tmp_entries:
        print("No temporary or orphan sessions found. Nothing to do.")
        return

    mode = "DRY-RUN" if not args.apply else "APPLY"

    # Report phase 1
    if tmp_entries:
        n_entries, n_dirs = len(tmp_entries), len(tmp_dirs)
        print(f"[{mode}] Phase 1: {n_entries} tmp workdir entries, {n_dirs} dirs.")
        for wd in tmp_entries[:10]:
            print(f"  {wd['path']}")
        if len(tmp_entries) > 10:
            print(f"  ... and {len(tmp_entries) - 10} more")
        print()

    # Report phase 2
    if orphan_dirs:
        n_orphans = len(orphan_dirs)
        print(f"[{mode}] Phase 2: {n_orphans} orphan session dirs.")
        for d in orphan_dirs[:5]:
            subdirs = list(d.iterdir())
            print(f"  {d.name}/ ({len(subdirs)} session(s))")
        if len(orphan_dirs) > 5:
            print(f"  ... and {len(orphan_dirs) - 5} more")
        print()

    total_size = sum(dir_total_size(d) for d in all_dirs_to_remove)
    print(f"Total: {len(all_dirs_to_remove)} directories, {total_size / 1024 / 1024:.1f} MB")

    if not args.apply:
        print("\nRe-run with --apply to delete.")
        return

    # Delete session directories
    for d in all_dirs_to_remove:
        shutil.rmtree(d)
    print(f"\nRemoved {len(all_dirs_to_remove)} session directories.")

    # Update metadata (remove tmp entries)
    if tmp_entries:
        metadata["work_dirs"] = keep_entries
        with open(METADATA_FILE, "w", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)
        print(f"Updated {METADATA_FILE.name}: {len(work_dirs)} -> {len(keep_entries)} work_dirs.")


if __name__ == "__main__":
    main()

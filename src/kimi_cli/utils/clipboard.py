from __future__ import annotations

import importlib
import os
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import pyperclip
from PIL import Image, ImageGrab

# Video file extensions recognized for clipboard paste.
_VIDEO_SUFFIXES: frozenset[str] = frozenset(
    {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".m4v", ".flv", ".3gp", ".3g2"}
)


@dataclass(frozen=True, slots=True)
class ClipboardImage:
    image: Image.Image


@dataclass(frozen=True, slots=True)
class ClipboardVideo:
    path: Path


def is_clipboard_available() -> bool:
    """Check if the Pyperclip clipboard is available."""
    try:
        pyperclip.paste()
        return True
    except Exception:
        return False


def grab_media_from_clipboard() -> ClipboardImage | ClipboardVideo | None:
    """Read media from the clipboard.

    Inspects the clipboard once and returns the most specific media type found.
    Priority: video file > image file > raw image data (e.g. screenshots).

    This ordering ensures that a video file copied from Finder is never
    misidentified as its macOS-generated thumbnail image.
    """
    # 1. Try macOS native API for file paths (most reliable for Finder copies).
    if sys.platform == "darwin":
        file_paths = _read_clipboard_file_paths_macos_native()
        result = _classify_file_paths(file_paths)
        if result is not None:
            return result

    # 2. Try PIL ImageGrab as fallback.
    #    - On macOS this uses AppleScript «class furl» for file paths,
    #      or reads raw image data (TIFF/PNG) from the pasteboard.
    #    - On other platforms this is the primary clipboard access method.
    payload = ImageGrab.grabclipboard()
    if payload is None:
        return None
    if isinstance(payload, Image.Image):
        # Raw image data (screenshot or thumbnail) — return as image.
        # Note: if a video file was copied, the native path above would have
        # already caught it. Reaching here means no video file was found.
        return ClipboardImage(image=payload)
    # payload is a list of file path strings.
    return _classify_file_paths(payload)


def _classify_file_paths(
    paths: Iterable[os.PathLike[str] | str],
) -> ClipboardImage | ClipboardVideo | None:
    """Classify file paths from clipboard: check for video first, then image."""
    resolved: list[Path] = []
    for item in paths:
        try:
            path = Path(item)
        except (TypeError, ValueError):
            continue
        if not path.is_file():
            continue
        resolved.append(path)

    # Video takes priority over image.
    for path in resolved:
        if path.suffix.lower() in _VIDEO_SUFFIXES:
            return ClipboardVideo(path=path)

    # Then try opening as image.
    for path in resolved:
        try:
            with Image.open(path) as img:
                img.load()
                return ClipboardImage(image=img.copy())
        except Exception:
            continue

    return None


def _read_clipboard_file_paths_macos_native() -> list[Path]:
    try:
        appkit = cast(Any, importlib.import_module("AppKit"))
        foundation = cast(Any, importlib.import_module("Foundation"))
    except Exception:
        return []

    NSPasteboard = appkit.NSPasteboard
    NSURL = foundation.NSURL
    options_key = getattr(
        appkit,
        "NSPasteboardURLReadingFileURLsOnlyKey",
        "NSPasteboardURLReadingFileURLsOnlyKey",
    )

    pb = NSPasteboard.generalPasteboard()
    options = {options_key: True}
    try:
        urls: list[Any] | None = pb.readObjectsForClasses_options_([NSURL], options)
    except Exception:
        urls = None

    paths: list[Path] = []
    if urls:
        for url in urls:
            try:
                path = url.path()
            except Exception:
                continue
            if path:
                paths.append(Path(str(path)))

    if paths:
        return paths

    try:
        file_list = cast(list[str] | str | None, pb.propertyListForType_("NSFilenamesPboardType"))
    except Exception:
        return []

    if not file_list:
        return []

    file_items: list[str] = []
    if isinstance(file_list, list):
        file_items.extend(item for item in file_list if item)
    else:
        file_items.append(file_list)

    return [Path(item) for item in file_items]

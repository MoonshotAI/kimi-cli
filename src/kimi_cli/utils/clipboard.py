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
class ClipboardResult:
    """Result of reading media from the clipboard.

    Both fields may be non-empty when the clipboard contains a mix of
    image files and non-image files (videos, PDFs, etc.).
    """

    images: tuple[Image.Image, ...]
    file_paths: tuple[Path, ...]


def is_clipboard_available() -> bool:
    """Check if the Pyperclip clipboard is available."""
    try:
        pyperclip.paste()
        return True
    except Exception:
        return False


def grab_media_from_clipboard() -> ClipboardResult | None:
    """Read media from the clipboard.

    Inspects the clipboard once and returns all detected media.
    Image files are returned as loaded PIL images; non-image files
    (videos, PDFs, etc.) are returned as file paths.

    On macOS the native pasteboard API is tried first to avoid
    misidentifying a file's thumbnail as clipboard image data.
    """
    # 1. Try macOS native API for file paths (most reliable for Finder copies).
    if sys.platform == "darwin":
        file_paths = _read_clipboard_file_paths_macos_native()
        images, non_image_paths = _classify_file_paths(file_paths)
        if images or non_image_paths:
            return ClipboardResult(
                images=tuple(images),
                file_paths=tuple(non_image_paths),
            )

    # 2. Try PIL ImageGrab as fallback.
    #    - On macOS this uses AppleScript «class furl» for file paths,
    #      or reads raw image data (TIFF/PNG) from the pasteboard.
    #    - On other platforms this is the primary clipboard access method.
    payload = ImageGrab.grabclipboard()
    if payload is None:
        return None
    if isinstance(payload, Image.Image):
        # Raw image data (screenshot or thumbnail).
        # If we reach here, the macOS native path lookup did not find any
        # file paths, so this is safe to treat as a real image.
        return ClipboardResult(images=(payload,), file_paths=())
    # payload is a list of file path strings.
    images, non_image_paths = _classify_file_paths(payload)
    if images or non_image_paths:
        return ClipboardResult(
            images=tuple(images),
            file_paths=tuple(non_image_paths),
        )
    return None


def _classify_file_paths(
    paths: Iterable[os.PathLike[str] | str],
) -> tuple[list[Image.Image], list[Path]]:
    """Classify clipboard file paths into images and non-image files.

    Returns ``(images, non_image_paths)`` where *images* contains loaded
    PIL images and *non_image_paths* contains paths to videos, documents,
    and other non-image files.
    """
    resolved: list[Path] = []
    for item in paths:
        try:
            path = Path(item)
        except (TypeError, ValueError):
            continue
        if not path.is_file():
            continue
        resolved.append(path)

    images: list[Image.Image] = []
    non_image_paths: list[Path] = []

    for path in resolved:
        # Video files are never opened as images.
        if path.suffix.lower() in _VIDEO_SUFFIXES:
            non_image_paths.append(path)
            continue
        try:
            with Image.open(path) as img:
                img.load()
                images.append(img.copy())
        except Exception:
            non_image_paths.append(path)

    return images, non_image_paths


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

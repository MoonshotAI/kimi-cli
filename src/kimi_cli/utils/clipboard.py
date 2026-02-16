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

# Video file extensions that are supported for clipboard paste
VIDEO_EXTENSIONS = {
    ".mp4",
    ".mkv",
    ".avi",
    ".mov",
    ".wmv",
    ".webm",
    ".m4v",
    ".flv",
    ".3gp",
    ".3g2",
}


def is_clipboard_available() -> bool:
    """Check if the Pyperclip clipboard is available."""
    try:
        pyperclip.paste()
        return True
    except Exception:
        return False


def grab_image_from_clipboard() -> Image.Image | None:
    """Read an image from the clipboard if possible."""
    if sys.platform == "darwin":
        image = _open_first_image(_read_clipboard_file_paths_macos_native())
        if image is not None:
            return image

    payload = ImageGrab.grabclipboard()
    if payload is None:
        return None
    if isinstance(payload, Image.Image):
        return payload
    return _open_first_image(payload)


@dataclass(frozen=True)
class ClipboardVideo:
    """Represents a video file from clipboard."""

    path: Path


def grab_video_from_clipboard() -> ClipboardVideo | None:
    """Read a video file path from the clipboard if possible.

    Returns the first video file found in the clipboard file paths.
    """
    # On macOS, try native file path reading first
    if sys.platform == "darwin":
        paths = _read_clipboard_file_paths_macos_native()
        video = _find_first_video(paths)
        if video is not None:
            return video

    # Try Windows/Linux - ImageGrab may return file paths
    try:
        payload = ImageGrab.grabclipboard()
        if isinstance(payload, list):
            paths: list[Path] = []
            for p in payload:
                try:
                    paths.append(Path(p))
                except (TypeError, ValueError):
                    continue
            return _find_first_video(paths)
    except Exception:
        pass

    # Try parsing clipboard text as a file path
    try:
        text = pyperclip.paste()
        if text:
            path = Path(text.strip().strip('"\''))
            if path.is_file() and _is_video_file(path):
                return ClipboardVideo(path=path)
    except Exception:
        pass

    return None


def _is_video_file(path: Path) -> bool:
    """Check if a file is a video based on extension."""
    return path.suffix.lower() in VIDEO_EXTENSIONS


def _find_first_video(paths: Iterable[Path]) -> ClipboardVideo | None:
    """Find the first video file in a list of paths."""
    for path in paths:
        if path.is_file() and _is_video_file(path):
            return ClipboardVideo(path=path)
    return None


def _open_first_image(paths: Iterable[os.PathLike[str] | str]) -> Image.Image | None:
    for item in paths:
        try:
            path = Path(item)
        except (TypeError, ValueError):
            continue
        if not path.is_file():
            continue
        try:
            with Image.open(path) as img:
                img.load()
                return img.copy()
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

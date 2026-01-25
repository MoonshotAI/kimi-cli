from __future__ import annotations

import importlib
import os
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any, cast

import pyperclip
from PIL import Image, ImageGrab


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

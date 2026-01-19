from __future__ import annotations

import mimetypes
from dataclasses import dataclass
from pathlib import PurePath
from typing import Literal

MEDIA_SNIFF_BYTES = 512

_EXTRA_MIME_TYPES = {
    ".avif": "image/avif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".mkv": "video/x-matroska",
    ".m4v": "video/x-m4v",
    ".3gp": "video/3gpp",
    ".3g2": "video/3gpp2",
    # TypeScript files: override mimetypes default (video/mp2t for MPEG Transport Stream)
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".mts": "text/typescript",
    ".cts": "text/typescript",
}

for suffix, mime_type in _EXTRA_MIME_TYPES.items():
    mimetypes.add_type(mime_type, suffix)

_IMAGE_MIME_BY_SUFFIX = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".svgz": "image/svg+xml",
}
_VIDEO_MIME_BY_SUFFIX = {
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".wmv": "video/x-ms-wmv",
    ".webm": "video/webm",
    ".m4v": "video/x-m4v",
    ".flv": "video/x-flv",
    ".3gp": "video/3gpp",
    ".3g2": "video/3gpp2",
}

_ASF_HEADER = b"\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9\x00\xaa\x00\x62\xce\x6c"
_FTYP_IMAGE_BRANDS = {
    "avif": "image/avif",
    "avis": "image/avif",
    "heic": "image/heic",
    "heif": "image/heif",
    "heix": "image/heif",
    "hevc": "image/heic",
    "mif1": "image/heif",
    "msf1": "image/heif",
}
_FTYP_VIDEO_BRANDS = {
    "isom": "video/mp4",
    "iso2": "video/mp4",
    "mp41": "video/mp4",
    "mp42": "video/mp4",
    "avc1": "video/mp4",
    "mp4v": "video/mp4",
    "m4v": "video/x-m4v",
    "qt": "video/quicktime",
    "3gp4": "video/3gpp",
    "3gp5": "video/3gpp",
    "3gp6": "video/3gpp",
    "3gp7": "video/3gpp",
    "3g2": "video/3gpp2",
}

_NON_TEXT_SUFFIXES = {
    ".icns",
    ".psd",
    ".ai",
    ".eps",
    # Documents / office formats
    ".pdf",
    ".doc",
    ".docx",
    ".dot",
    ".dotx",
    ".rtf",
    ".odt",
    ".xls",
    ".xlsx",
    ".xlsm",
    ".xlt",
    ".xltx",
    ".xltm",
    ".ods",
    ".ppt",
    ".pptx",
    ".pptm",
    ".pps",
    ".ppsx",
    ".odp",
    ".pages",
    ".numbers",
    ".key",
    # Archives / compressed
    ".zip",
    ".rar",
    ".7z",
    ".tar",
    ".gz",
    ".tgz",
    ".bz2",
    ".xz",
    ".zst",
    ".lz",
    ".lz4",
    ".br",
    ".cab",
    ".ar",
    ".deb",
    ".rpm",
    # Audio
    ".mp3",
    ".wav",
    ".flac",
    ".ogg",
    ".oga",
    ".opus",
    ".aac",
    ".m4a",
    ".wma",
    # Fonts
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    # Binaries / bundles
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
    ".apk",
    ".ipa",
    ".jar",
    ".class",
    ".pyc",
    ".pyo",
    ".wasm",
    # Disk images / databases
    ".dmg",
    ".iso",
    ".img",
    ".sqlite",
    ".sqlite3",
    ".db",
    ".db3",
}


@dataclass(frozen=True)
class FileType:
    kind: Literal["text", "image", "video", "unknown"]
    mime_type: str


def _sniff_ftyp_brand(header: bytes) -> str | None:
    if len(header) < 12 or header[4:8] != b"ftyp":
        return None
    brand = header[8:12].decode("ascii", errors="ignore").lower()
    return brand.strip()


def sniff_media_from_magic(data: bytes) -> FileType | None:
    header = data[:MEDIA_SNIFF_BYTES]
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return FileType(kind="image", mime_type="image/png")
    if header.startswith(b"\xff\xd8\xff"):
        return FileType(kind="image", mime_type="image/jpeg")
    if header.startswith((b"GIF87a", b"GIF89a")):
        return FileType(kind="image", mime_type="image/gif")
    if header.startswith(b"BM"):
        return FileType(kind="image", mime_type="image/bmp")
    if header.startswith((b"II*\x00", b"MM\x00*")):
        return FileType(kind="image", mime_type="image/tiff")
    if header.startswith(b"\x00\x00\x01\x00"):
        return FileType(kind="image", mime_type="image/x-icon")
    if header.startswith(b"RIFF") and len(header) >= 12:
        chunk = header[8:12]
        if chunk == b"WEBP":
            return FileType(kind="image", mime_type="image/webp")
        if chunk == b"AVI ":
            return FileType(kind="video", mime_type="video/x-msvideo")
    if header.startswith(b"FLV"):
        return FileType(kind="video", mime_type="video/x-flv")
    if header.startswith(_ASF_HEADER):
        return FileType(kind="video", mime_type="video/x-ms-wmv")
    if header.startswith(b"\x1a\x45\xdf\xa3"):
        lowered = header.lower()
        if b"webm" in lowered:
            return FileType(kind="video", mime_type="video/webm")
        if b"matroska" in lowered:
            return FileType(kind="video", mime_type="video/x-matroska")
    if brand := _sniff_ftyp_brand(header):
        if brand in _FTYP_IMAGE_BRANDS:
            return FileType(kind="image", mime_type=_FTYP_IMAGE_BRANDS[brand])
        if brand in _FTYP_VIDEO_BRANDS:
            return FileType(kind="video", mime_type=_FTYP_VIDEO_BRANDS[brand])
    return None


def detect_file_type(path: str | PurePath, header: bytes | None = None) -> FileType:
    suffix = PurePath(str(path)).suffix.lower()
    media_hint: FileType | None = None
    if suffix in _IMAGE_MIME_BY_SUFFIX:
        media_hint = FileType(kind="image", mime_type=_IMAGE_MIME_BY_SUFFIX[suffix])
    elif suffix in _VIDEO_MIME_BY_SUFFIX:
        media_hint = FileType(kind="video", mime_type=_VIDEO_MIME_BY_SUFFIX[suffix])
    else:
        mime_type, _ = mimetypes.guess_type(str(path))
        if mime_type:
            if mime_type.startswith("image/"):
                media_hint = FileType(kind="image", mime_type=mime_type)
            elif mime_type.startswith("video/"):
                media_hint = FileType(kind="video", mime_type=mime_type)

    if header is not None:
        sniffed = sniff_media_from_magic(header)
        if sniffed:
            if media_hint and sniffed.kind != media_hint.kind:
                return FileType(kind="unknown", mime_type="")
            return sniffed
        # NUL bytes are a strong signal of binary content.
        if b"\x00" in header:
            return FileType(kind="unknown", mime_type="")

    if media_hint:
        return media_hint
    if suffix in _NON_TEXT_SUFFIXES:
        return FileType(kind="unknown", mime_type="")
    return FileType(kind="text", mime_type="text/plain")

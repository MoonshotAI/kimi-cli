from __future__ import annotations

import base64

from PIL import Image

from kimi_cli.ui.shell.prompt import AttachmentCache, _parse_attachment_kind
from kimi_cli.utils.clipboard import ClipboardVideo
from kimi_cli.wire.types import ImageURLPart, TextPart


def _make_image() -> Image.Image:
    return Image.new("RGB", (2, 2), color=(10, 20, 30))


def test_attachment_cache_roundtrip(tmp_path) -> None:
    cache = AttachmentCache(root=tmp_path)
    image = _make_image()

    cached = cache.store_image(image)
    assert cached is not None
    assert cached.path.exists()
    assert cached.path.parent == tmp_path / "images"

    parts = cache.load_content_parts("image", cached.attachment_id)
    assert parts is not None
    assert len(parts) == 3
    assert parts[0] == TextPart(text=f'<image path="{cached.path}">')
    assert isinstance(parts[1], ImageURLPart)
    assert parts[2] == TextPart(text="</image>")
    assert parts[1].image_url.url.startswith("data:image/png;base64,")

    encoded = parts[1].image_url.url.split(",", 1)[1]
    assert base64.b64decode(encoded).startswith(b"\x89PNG")


def test_parse_attachment_kind() -> None:
    assert _parse_attachment_kind("image") == "image"
    assert _parse_attachment_kind("text") is None


def test_attachment_cache_dedupes_bytes(tmp_path) -> None:
    cache = AttachmentCache(root=tmp_path)
    payload = b"same-bytes"

    cached_first = cache.store_bytes("image", ".png", payload)
    cached_second = cache.store_bytes("image", ".png", payload)

    assert cached_first is not None
    assert cached_second is not None
    assert cached_first.attachment_id == cached_second.attachment_id
    assert cached_first.path == cached_second.path
    assert cached_first.path.read_bytes() == payload
    assert len(list((tmp_path / "images").iterdir())) == 1


def test_parse_attachment_kind_video() -> None:
    assert _parse_attachment_kind("video") == "video"
    assert _parse_attachment_kind("unknown") is None


def test_attachment_cache_video_reference(tmp_path) -> None:
    cache = AttachmentCache(root=tmp_path)
    video_path = tmp_path / "test_video.mp4"
    video_path.write_text("fake video content")

    video = ClipboardVideo(path=video_path)
    cached = cache.store_video_reference(video)
    assert cached is not None
    assert cached.path.exists()
    assert cached.path.parent == tmp_path / "videos"
    assert cached.path.read_text() == str(video_path)


def test_attachment_cache_video_load_parts(tmp_path) -> None:
    cache = AttachmentCache(root=tmp_path)
    video_path = tmp_path / "test_video.mp4"
    video_path.write_text("fake video content")

    video = ClipboardVideo(path=video_path)
    cached = cache.store_video_reference(video)
    assert cached is not None

    parts = cache.load_content_parts("video", cached.attachment_id)
    assert parts is not None
    assert len(parts) == 1
    assert isinstance(parts[0], TextPart)
    assert parts[0].text == f"@{video_path}"


def test_attachment_cache_video_missing_file(tmp_path) -> None:
    cache = AttachmentCache(root=tmp_path)
    # Try to load a non-existent video
    parts = cache.load_content_parts("video", "nonexistent.ref")
    assert parts is None


def test_attachment_cache_video_removed_original(tmp_path) -> None:
    cache = AttachmentCache(root=tmp_path)
    video_path = tmp_path / "test_video.mp4"
    video_path.write_text("fake video content")

    video = ClipboardVideo(path=video_path)
    cached = cache.store_video_reference(video)
    assert cached is not None

    # Remove the original video file
    video_path.unlink()

    # Should return None because the original file is gone
    parts = cache.load_content_parts("video", cached.attachment_id)
    assert parts is None

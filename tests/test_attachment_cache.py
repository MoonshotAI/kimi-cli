from __future__ import annotations

import base64

from PIL import Image

from kimi_cli.ui.shell.prompt import AttachmentCache, _parse_attachment_kind
from kimi_cli.wire.types import ImageURLPart


def _make_image() -> Image.Image:
    return Image.new("RGB", (2, 2), color=(10, 20, 30))


def test_attachment_cache_roundtrip(tmp_path) -> None:
    cache = AttachmentCache(root=tmp_path)
    image = _make_image()

    cached = cache.store_image(image)
    assert cached is not None
    assert cached.path.exists()
    assert cached.path.parent == tmp_path / "images"

    part = cache.load_content_part("image", cached.attachment_id)
    assert isinstance(part, ImageURLPart)
    assert part.image_url.id == cached.attachment_id
    assert part.image_url.url.startswith("data:image/png;base64,")

    encoded = part.image_url.url.split(",", 1)[1]
    assert base64.b64decode(encoded).startswith(b"\x89PNG")


def test_parse_attachment_kind() -> None:
    assert _parse_attachment_kind("image") == "image"
    assert _parse_attachment_kind("text") is None

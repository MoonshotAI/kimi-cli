from __future__ import annotations

from pathlib import Path

from kimi_cli.utils.clipboard import ClipboardImage, ClipboardVideo, _classify_file_paths


def test_classify_video_file(tmp_path: Path) -> None:
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"\x00" * 10)

    result = _classify_file_paths([str(video)])
    assert isinstance(result, ClipboardVideo)
    assert result.path == video


def test_classify_image_file(tmp_path: Path) -> None:
    from PIL import Image

    img_path = tmp_path / "photo.png"
    Image.new("RGB", (2, 2)).save(img_path)

    result = _classify_file_paths([str(img_path)])
    assert isinstance(result, ClipboardImage)
    assert result.image.size == (2, 2)


def test_classify_video_over_image(tmp_path: Path) -> None:
    """Video files take priority over image files."""
    from PIL import Image

    img_path = tmp_path / "photo.png"
    Image.new("RGB", (2, 2)).save(img_path)
    video = tmp_path / "clip.mov"
    video.write_bytes(b"\x00" * 10)

    result = _classify_file_paths([str(img_path), str(video)])
    assert isinstance(result, ClipboardVideo)
    assert result.path == video


def test_classify_nonexistent_file() -> None:
    result = _classify_file_paths(["/nonexistent/file.mp4"])
    assert result is None


def test_classify_non_media_file(tmp_path: Path) -> None:
    txt = tmp_path / "notes.txt"
    txt.write_text("hello")

    result = _classify_file_paths([str(txt)])
    assert result is None


def test_classify_empty() -> None:
    result = _classify_file_paths([])
    assert result is None


def test_classify_all_video_suffixes(tmp_path: Path) -> None:
    from kimi_cli.utils.clipboard import _VIDEO_SUFFIXES

    for suffix in _VIDEO_SUFFIXES:
        f = tmp_path / f"test{suffix}"
        f.write_bytes(b"\x00")
        result = _classify_file_paths([str(f)])
        assert isinstance(result, ClipboardVideo), f"Failed for {suffix}"

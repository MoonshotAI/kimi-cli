from __future__ import annotations

import shutil
import sys
from pathlib import Path

from PIL import Image

from kimi_cli.utils.clipboard import (
    _VIDEO_SUFFIXES,
    _classify_file_paths,
    is_media_clipboard_available,
)


def test_classify_video_file(tmp_path: Path) -> None:
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"\x00" * 10)

    images, file_paths = _classify_file_paths([str(video)])
    assert images == []
    assert file_paths == [video]


def test_classify_image_file(tmp_path: Path) -> None:
    img_path = tmp_path / "photo.png"
    Image.new("RGB", (2, 2)).save(img_path)

    images, file_paths = _classify_file_paths([str(img_path)])
    assert len(images) == 1
    assert images[0].size == (2, 2)
    assert file_paths == []


def test_classify_video_and_image(tmp_path: Path) -> None:
    """Both video and image files are returned in their respective groups."""
    img_path = tmp_path / "photo.png"
    Image.new("RGB", (2, 2)).save(img_path)
    video = tmp_path / "clip.mov"
    video.write_bytes(b"\x00" * 10)

    images, file_paths = _classify_file_paths([str(img_path), str(video)])
    assert len(images) == 1
    assert images[0].size == (2, 2)
    assert file_paths == [video]


def test_classify_nonexistent_file() -> None:
    images, file_paths = _classify_file_paths(["/nonexistent/file.mp4"])
    assert images == []
    assert file_paths == []


def test_classify_non_media_file(tmp_path: Path) -> None:
    txt = tmp_path / "notes.txt"
    txt.write_text("hello")

    images, file_paths = _classify_file_paths([str(txt)])
    assert images == []
    assert file_paths == [txt]


def test_classify_empty() -> None:
    images, file_paths = _classify_file_paths([])
    assert images == []
    assert file_paths == []


def test_classify_pdf_file(tmp_path: Path) -> None:
    pdf = tmp_path / "document.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake content")

    images, file_paths = _classify_file_paths([str(pdf)])
    assert images == []
    assert file_paths == [pdf]


def test_classify_csv_file(tmp_path: Path) -> None:
    csv = tmp_path / "data.csv"
    csv.write_text("a,b,c\n1,2,3")

    images, file_paths = _classify_file_paths([str(csv)])
    assert images == []
    assert file_paths == [csv]


def test_classify_docx_file(tmp_path: Path) -> None:
    docx = tmp_path / "report.docx"
    docx.write_bytes(b"\x00" * 10)

    images, file_paths = _classify_file_paths([str(docx)])
    assert images == []
    assert file_paths == [docx]


def test_classify_multiple_generic_files(tmp_path: Path) -> None:
    """All non-media files should be preserved."""
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(b"%PDF")
    csv = tmp_path / "b.csv"
    csv.write_text("x,y")
    txt = tmp_path / "c.txt"
    txt.write_text("hello")

    images, file_paths = _classify_file_paths([str(pdf), str(csv), str(txt)])
    assert images == []
    assert file_paths == [pdf, csv, txt]


def test_classify_multiple_videos(tmp_path: Path) -> None:
    """All video files should be preserved."""
    v1 = tmp_path / "a.mp4"
    v1.write_bytes(b"\x00")
    v2 = tmp_path / "b.mov"
    v2.write_bytes(b"\x00")

    images, file_paths = _classify_file_paths([str(v1), str(v2)])
    assert images == []
    assert file_paths == [v1, v2]


def test_classify_multiple_images(tmp_path: Path) -> None:
    """All image files should be preserved."""
    img1 = tmp_path / "a.png"
    Image.new("RGB", (2, 2)).save(img1)
    img2 = tmp_path / "b.png"
    Image.new("RGB", (3, 3)).save(img2)

    images, file_paths = _classify_file_paths([str(img1), str(img2)])
    assert len(images) == 2
    assert images[0].size == (2, 2)
    assert images[1].size == (3, 3)
    assert file_paths == []


def test_classify_video_over_generic_file(tmp_path: Path) -> None:
    """Video files are classified as non-image alongside generic files."""
    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(b"%PDF")
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"\x00" * 10)

    images, file_paths = _classify_file_paths([str(pdf), str(video)])
    assert images == []
    assert set(file_paths) == {pdf, video}


def test_classify_image_over_generic_file(tmp_path: Path) -> None:
    """Image and generic files are separated into their groups."""
    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(b"%PDF")
    img_path = tmp_path / "photo.png"
    Image.new("RGB", (2, 2)).save(img_path)

    images, file_paths = _classify_file_paths([str(pdf), str(img_path)])
    assert len(images) == 1
    assert images[0].size == (2, 2)
    assert file_paths == [pdf]


def test_classify_mixed_all_types(tmp_path: Path) -> None:
    """Mix of videos, images, and generic files."""
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"\x00")
    img = tmp_path / "photo.png"
    Image.new("RGB", (4, 4)).save(img)
    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(b"%PDF")

    images, file_paths = _classify_file_paths([str(video), str(img), str(pdf)])
    assert len(images) == 1
    assert images[0].size == (4, 4)
    assert set(file_paths) == {video, pdf}


def test_classify_all_video_suffixes(tmp_path: Path) -> None:
    for suffix in _VIDEO_SUFFIXES:
        f = tmp_path / f"test{suffix}"
        f.write_bytes(b"\x00")
        images, file_paths = _classify_file_paths([str(f)])
        assert images == [], f"Failed for {suffix}"
        assert file_paths == [f], f"Failed for {suffix}"


# --- is_media_clipboard_available tests ---


def test_media_clipboard_available_linux_with_xclip(monkeypatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(
        shutil, "which", lambda cmd: "/usr/bin/xclip" if cmd == "xclip" else None
    )
    assert is_media_clipboard_available() is True


def test_media_clipboard_available_linux_with_wl_paste(monkeypatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(
        shutil, "which", lambda cmd: "/usr/bin/wl-paste" if cmd == "wl-paste" else None
    )
    assert is_media_clipboard_available() is True


def test_media_clipboard_available_linux_with_both_tools(monkeypatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(
        shutil, "which", lambda cmd: f"/usr/bin/{cmd}"
    )
    assert is_media_clipboard_available() is True


def test_media_clipboard_available_linux_without_tools(monkeypatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda _cmd: None)
    assert is_media_clipboard_available() is False


def test_media_clipboard_available_macos(monkeypatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    assert is_media_clipboard_available() is True


def test_media_clipboard_available_windows(monkeypatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    assert is_media_clipboard_available() is True

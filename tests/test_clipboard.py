from __future__ import annotations

import shutil
import sys
from pathlib import Path

from PIL import Image

from kimi_cli.utils.clipboard import (
    _VIDEO_SUFFIXES,
    _classify_file_paths,
    _grab_image_linux,
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
    monkeypatch.setattr(shutil, "which", lambda cmd: "/usr/bin/xclip" if cmd == "xclip" else None)
    assert is_media_clipboard_available() is True


def test_media_clipboard_available_linux_with_wl_paste(monkeypatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(
        shutil, "which", lambda cmd: "/usr/bin/wl-paste" if cmd == "wl-paste" else None
    )
    assert is_media_clipboard_available() is True


def test_media_clipboard_available_linux_with_both_tools(monkeypatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda cmd: f"/usr/bin/{cmd}")
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


# --- _grab_image_linux tests ---


def test_grab_image_linux_xclip_falls_back_to_wlpaste(monkeypatch, tmp_path: Path) -> None:
    """When xclip fails with a real error, fallback to wl-paste."""
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda cmd: f"/usr/bin/{cmd}")

    img_path = tmp_path / "clipboard.png"
    Image.new("RGB", (2, 2)).save(img_path)
    img_bytes = img_path.read_bytes()

    calls = []

    def fake_run(args, **_kwargs):
        calls.append(args[0])

        class FakeResult:
            returncode: int
            stdout: bytes
            stderr: bytes

        if args[0] == "xclip":
            r = FakeResult()
            r.returncode = 1
            r.stdout = b""
            r.stderr = b"connection refused"
            return r
        r = FakeResult()
        r.returncode = 0
        r.stdout = img_bytes
        r.stderr = b""
        return r

    monkeypatch.setattr("kimi_cli.utils.clipboard.subprocess.run", fake_run)

    result = _grab_image_linux()
    assert result is not None
    assert result.size == (2, 2)
    assert calls == ["xclip", "wl-paste"]


def test_grab_image_linux_xclip_silent_error_then_wlpaste_succeeds(
    monkeypatch, tmp_path: Path
) -> None:
    """When xclip reports a silent error, fallback to wl-paste."""
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda cmd: f"/usr/bin/{cmd}")

    img_path = tmp_path / "clipboard.png"
    Image.new("RGB", (2, 2)).save(img_path)
    img_bytes = img_path.read_bytes()

    calls = []

    def fake_run(args, **_kwargs):
        calls.append(args[0])

        class FakeResult:
            returncode: int
            stdout: bytes
            stderr: bytes

        if args[0] == "xclip":
            r = FakeResult()
            r.returncode = 1
            r.stdout = b""
            r.stderr = b"xclip: Error: There is no owner for the selection"
            return r
        r = FakeResult()
        r.returncode = 0
        r.stdout = img_bytes
        r.stderr = b""
        return r

    monkeypatch.setattr("kimi_cli.utils.clipboard.subprocess.run", fake_run)

    result = _grab_image_linux()
    assert result is not None
    assert result.size == (2, 2)
    assert calls == ["xclip", "wl-paste"]


def test_grab_image_linux_both_tools_silent_error(monkeypatch) -> None:
    """When both tools report silent errors, return None."""
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda cmd: f"/usr/bin/{cmd}")

    calls = []

    def fake_run(args, **_kwargs):
        calls.append(args[0])

        class FakeResult:
            returncode = 1
            stdout = b""
            stderr = b"No selection"

        return FakeResult()

    monkeypatch.setattr("kimi_cli.utils.clipboard.subprocess.run", fake_run)

    result = _grab_image_linux()
    assert result is None
    assert calls == ["xclip", "wl-paste"]


def test_grab_image_linux_xclip_missing_wlpaste_succeeds(monkeypatch, tmp_path: Path) -> None:
    """When xclip is not installed, wl-paste is used directly."""
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(
        shutil, "which", lambda cmd: "/usr/bin/wl-paste" if cmd == "wl-paste" else None
    )

    img_path = tmp_path / "clipboard.png"
    Image.new("RGB", (3, 3)).save(img_path)
    img_bytes = img_path.read_bytes()

    calls = []

    def fake_run(args, **_kwargs):
        calls.append(args[0])

        class FakeResult:
            returncode = 0
            stdout = img_bytes
            stderr = b""

        return FakeResult()

    monkeypatch.setattr("kimi_cli.utils.clipboard.subprocess.run", fake_run)

    result = _grab_image_linux()
    assert result is not None
    assert result.size == (3, 3)
    assert calls == ["wl-paste"]


def test_grab_image_linux_both_tools_missing(monkeypatch) -> None:
    """When no clipboard tool is available, return None."""
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda _cmd: None)

    result = _grab_image_linux()
    assert result is None


def test_grab_image_linux_xclip_succeeds(monkeypatch, tmp_path: Path) -> None:
    """When xclip succeeds immediately, wl-paste is not tried."""
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda cmd: f"/usr/bin/{cmd}")

    img_path = tmp_path / "clipboard.png"
    Image.new("RGB", (4, 4)).save(img_path)
    img_bytes = img_path.read_bytes()

    calls = []

    def fake_run(args, **_kwargs):
        calls.append(args[0])

        class FakeResult:
            returncode = 0
            stdout = img_bytes
            stderr = b""

        return FakeResult()

    monkeypatch.setattr("kimi_cli.utils.clipboard.subprocess.run", fake_run)

    result = _grab_image_linux()
    assert result is not None
    assert result.size == (4, 4)
    assert calls == ["xclip"]


def test_grab_image_linux_wayland_prefers_wlpaste(monkeypatch, tmp_path: Path) -> None:
    """On Wayland, wl-paste is tried first."""
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda cmd: f"/usr/bin/{cmd}")
    monkeypatch.setenv("WAYLAND_DISPLAY", "wayland-1")

    img_path = tmp_path / "clipboard.png"
    Image.new("RGB", (5, 5)).save(img_path)
    img_bytes = img_path.read_bytes()

    calls = []

    def fake_run(args, **_kwargs):
        calls.append(args[0])

        class FakeResult:
            returncode = 0
            stdout = img_bytes
            stderr = b""

        return FakeResult()

    monkeypatch.setattr("kimi_cli.utils.clipboard.subprocess.run", fake_run)

    result = _grab_image_linux()
    assert result is not None
    assert result.size == (5, 5)
    assert calls == ["wl-paste"]


def test_grab_image_linux_wayland_wlpaste_falls_back_to_xclip(monkeypatch, tmp_path: Path) -> None:
    """On Wayland, if wl-paste fails with real error, fallback to xclip."""
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda cmd: f"/usr/bin/{cmd}")
    monkeypatch.setenv("WAYLAND_DISPLAY", "wayland-1")

    img_path = tmp_path / "clipboard.png"
    Image.new("RGB", (6, 6)).save(img_path)
    img_bytes = img_path.read_bytes()

    calls = []

    def fake_run(args, **_kwargs):
        calls.append(args[0])

        class FakeResult:
            returncode: int
            stdout: bytes
            stderr: bytes

        if args[0] == "wl-paste":
            r = FakeResult()
            r.returncode = 1
            r.stdout = b""
            r.stderr = b"connection refused"
            return r
        r = FakeResult()
        r.returncode = 0
        r.stdout = img_bytes
        r.stderr = b""
        return r

    monkeypatch.setattr("kimi_cli.utils.clipboard.subprocess.run", fake_run)

    result = _grab_image_linux()
    assert result is not None
    assert result.size == (6, 6)
    assert calls == ["wl-paste", "xclip"]


def test_grab_image_linux_x11_prefers_xclip(monkeypatch, tmp_path: Path) -> None:
    """On X11, xclip is tried first."""
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda cmd: f"/usr/bin/{cmd}")
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)

    img_path = tmp_path / "clipboard.png"
    Image.new("RGB", (7, 7)).save(img_path)
    img_bytes = img_path.read_bytes()

    calls = []

    def fake_run(args, **_kwargs):
        calls.append(args[0])

        class FakeResult:
            returncode = 0
            stdout = img_bytes
            stderr = b""

        return FakeResult()

    monkeypatch.setattr("kimi_cli.utils.clipboard.subprocess.run", fake_run)

    result = _grab_image_linux()
    assert result is not None
    assert result.size == (7, 7)
    assert calls == ["xclip"]


def test_grab_image_linux_timeout(monkeypatch) -> None:
    """When subprocess times out, continue to next backend."""
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda cmd: f"/usr/bin/{cmd}")

    calls = []

    def fake_run(args, **_kwargs):
        calls.append(args[0])
        import subprocess

        raise subprocess.TimeoutExpired(cmd=args[0], timeout=3)

    monkeypatch.setattr("kimi_cli.utils.clipboard.subprocess.run", fake_run)

    result = _grab_image_linux()
    assert result is None
    assert calls == ["xclip", "wl-paste"]

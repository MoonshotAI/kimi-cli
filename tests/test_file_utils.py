from __future__ import annotations

from kimi_cli.tools.file.utils import detect_file_type


def test_detect_file_type_suffixes():
    assert detect_file_type("image.PNG").kind == "image"
    assert detect_file_type("clip.mp4").kind == "video"
    assert detect_file_type("notes.txt").kind == "text"
    assert detect_file_type("Makefile").kind == "text"
    assert detect_file_type(".env").kind == "text"
    assert detect_file_type("archive.tar.gz").kind == "unknown"
    assert detect_file_type("my file.pdf").kind == "unknown"
    # TypeScript files should not be misidentified as MPEG Transport Stream (video/mp2t)
    assert detect_file_type("app.ts").kind == "text"
    assert detect_file_type("component.tsx").kind == "text"
    assert detect_file_type("module.mts").kind == "text"
    assert detect_file_type("common.cts").kind == "text"


def test_detect_file_type_header_overrides():
    png_header = b"\x89PNG\r\n\x1a\n" + b"pngdata"
    mp4_header = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
    binary_header = b"\x00\x00binary"

    assert detect_file_type("sample", header=png_header).kind == "image"
    assert detect_file_type("sample.bin", header=png_header).mime_type == "image/png"
    assert detect_file_type("sample", header=mp4_header).kind == "video"
    assert detect_file_type("sample.png", header=mp4_header).kind == "unknown"
    assert detect_file_type("notes.txt", header=binary_header).kind == "unknown"

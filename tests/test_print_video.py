from __future__ import annotations

from pathlib import Path

from kimi_cli.ui.print import _build_content_parts, _extract_video_paths
from kimi_cli.wire.types import TextPart


class TestExtractVideoPaths:
    def test_no_video_paths(self, tmp_path):
        text = "This is just some text without any video files"
        result = _extract_video_paths(text)
        assert result == []

    def test_single_video_path(self, tmp_path):
        video_file = tmp_path / "test_video.mp4"
        video_file.write_text("fake video content")
        
        text = f"Please analyze {video_file} for me"
        result = _extract_video_paths(text)
        
        assert len(result) == 1
        start, end, path = result[0]
        assert path == video_file
        assert text[start:end] == str(video_file)

    def test_multiple_video_paths(self, tmp_path):
        video1 = tmp_path / "first.mkv"
        video2 = tmp_path / "second.mov"
        video1.write_text("fake content 1")
        video2.write_text("fake content 2")
        
        text = f"Compare {video1} with {video2}"
        result = _extract_video_paths(text)
        
        assert len(result) == 2
        assert result[0][2] == video1
        assert result[1][2] == video2

    def test_video_path_with_at_mention(self, tmp_path):
        video_file = tmp_path / "clip.webm"
        video_file.write_text("fake video")
        
        text = f"Check out @{video_file}"
        result = _extract_video_paths(text)
        
        assert len(result) == 1
        assert result[0][2] == video_file

    def test_nonexistent_video_file(self, tmp_path):
        video_file = tmp_path / "does_not_exist.mp4"
        
        text = f"Analyze {video_file}"
        result = _extract_video_paths(text)
        
        # Should not include files that don't exist
        assert result == []

    def test_non_video_file(self, tmp_path):
        text_file = tmp_path / "readme.txt"
        text_file.write_text("just text")
        
        text = f"Read {text_file}"
        result = _extract_video_paths(text)
        
        # Should not include non-video files
        assert result == []


class TestBuildContentParts:
    def test_plain_text_no_videos(self):
        command = "Just a simple command"
        parts = _build_content_parts(command)
        
        assert len(parts) == 1
        assert isinstance(parts[0], TextPart)
        assert parts[0].text == command

    def test_single_video(self, tmp_path):
        video_file = tmp_path / "test.avi"
        video_file.write_text("fake video")
        
        command = f"Analyze this video: {video_file}"
        parts = _build_content_parts(command)
        
        # Should have: text + video tag open + video tag close (no trailing text)
        assert len(parts) == 3
        assert parts[0].text == "Analyze this video: "
        assert '<video path="' in parts[1].text
        assert '</video>' in parts[2].text

    def test_multiple_videos(self, tmp_path):
        video1 = tmp_path / "a.mp4"
        video2 = tmp_path / "b.mkv"
        video1.write_text("v1")
        video2.write_text("v2")
        
        command = f"Compare {video1} and {video2} please"
        parts = _build_content_parts(command)
        
        # Should have text parts and video tags for both videos
        # text + video1 open/close + text + video2 open/close + text = 7 parts
        assert len(parts) == 7
        assert "Compare " in parts[0].text
        assert str(video1) in parts[1].text
        assert " and " in parts[3].text
        assert str(video2) in parts[4].text
        assert " please" in parts[6].text

    def test_video_with_mime_type(self, tmp_path):
        # Test MKV file gets correct mime type
        video_file = tmp_path / "movie.mkv"
        video_file.write_text("fake mkv")
        
        command = str(video_file)
        parts = _build_content_parts(command)
        
        assert len(parts) == 2
        assert 'content_type="video/x-matroska"' in parts[0].text

    def test_mp4_with_mime_type(self, tmp_path):
        video_file = tmp_path / "clip.mp4"
        video_file.write_text("fake mp4")
        
        command = str(video_file)
        parts = _build_content_parts(command)
        
        assert 'content_type="video/mp4"' in parts[0].text

    def test_all_supported_extensions(self, tmp_path):
        extensions = [".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".m4v", ".flv", ".3gp", ".3g2"]
        
        for ext in extensions:
            video_file = tmp_path / f"test{ext}"
            video_file.write_text("fake")
            
            result = _extract_video_paths(str(video_file))
            assert len(result) == 1, f"Extension {ext} should be detected"
            assert result[0][2].suffix.lower() == ext

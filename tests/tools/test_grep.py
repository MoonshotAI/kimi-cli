"""Tests for the grep tool."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from inline_snapshot import snapshot

from kimi_cli.tools.file.grep_local import Grep, Params, _build_rg_args, _strip_path_prefix
from kimi_cli.tools.utils import DEFAULT_MAX_CHARS


@pytest.fixture
def temp_test_files():
    """Create temporary test files for grep testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        # Create test files
        test_file1 = Path(temp_dir) / "test1.py"
        test_file1.write_text("""def hello_world():
    print("Hello, World!")
    return "hello"

class TestClass:
    def __init__(self):
        self.message = "hello there"
""")

        test_file2 = Path(temp_dir) / "test2.js"
        test_file2.write_text("""function helloWorld() {
    console.log("Hello, World!");
    return "hello";
}

class TestClass {
    constructor() {
        this.message = "hello there";
    }
}
""")

        test_file3 = Path(temp_dir) / "readme.txt"
        test_file3.write_text("""This is a readme file.
It contains some text.
Hello world example is here.
""")

        # Create a subdirectory with files
        subdir = Path(temp_dir) / "subdir"
        subdir.mkdir()
        subfile = subdir / "subtest.py"
        subfile.write_text("def sub_hello():\n    return 'hello from subdir'\n")

        yield temp_dir, [test_file1, test_file2, test_file3, subfile]


async def test_grep_files_with_matches(grep_tool: Grep, temp_test_files):
    """Test finding files that contain a pattern."""
    temp_dir, test_files = temp_test_files

    # Test basic pattern matching to catch "Hello" in readme.txt
    result = await grep_tool(
        Params(pattern="Hello", path=temp_dir, output_mode="files_with_matches")
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should find all test files that contain "hello" (case insensitive)
    assert "test1.py" in result.output
    assert "test2.js" in result.output
    assert "readme.txt" in result.output


async def test_grep_content_mode(grep_tool: Grep, temp_test_files):
    """Test showing matching lines with content."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "hello",
                "path": temp_dir,
                "output_mode": "content",
                "-n": True,
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should show matching lines with line numbers
    assert "hello" in result.output.lower()
    assert ":" in result.output  # Line numbers should be present


async def test_grep_case_insensitive(grep_tool: Grep, temp_test_files):
    """Test case insensitive search."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "HELLO",
                "path": temp_dir,
                "output_mode": "files_with_matches",
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should find files with "hello" (lowercase)
    assert "test1.py" in result.output


async def test_grep_with_context(grep_tool: Grep, temp_test_files):
    """Test showing context around matches."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "TestClass",
                "path": temp_dir,
                "output_mode": "content",
                "-C": 1,
                "-n": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should show context lines
    lines = result.output.split("\n")
    assert len(lines) > 2  # Should have more than just the matching line


async def test_grep_count_matches(grep_tool: Grep, temp_test_files):
    """Test counting matches."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "hello",
                "path": temp_dir,
                "output_mode": "count_matches",
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should show count for each file
    assert "test1.py" in result.output
    assert "test2.js" in result.output


async def test_grep_with_glob_pattern(grep_tool: Grep, temp_test_files):
    """Test filtering files with glob pattern."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "hello",
                "path": temp_dir,
                "output_mode": "files_with_matches",
                "glob": "*.py",
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should only find Python files
    assert "test1.py" in result.output
    assert "subtest.py" in result.output
    assert "test2.js" not in result.output
    assert "readme.txt" not in result.output


async def test_grep_with_type_filter(grep_tool: Grep, temp_test_files):
    """Test filtering by file type."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "hello",
                "path": temp_dir,
                "output_mode": "files_with_matches",
                "type": "py",
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should only find Python files
    assert "test1.py" in result.output
    assert "subtest.py" in result.output
    assert "test2.js" not in result.output
    assert "readme.txt" not in result.output


async def test_grep_head_limit(grep_tool: Grep, temp_test_files):
    """Test limiting number of results."""
    temp_dir, test_files = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "hello",
                "path": temp_dir,
                "output_mode": "files_with_matches",
                "head_limit": 2,
                "-i": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)

    # Should limit results to 2 files
    lines = [
        line for line in result.output.split("\n") if line.strip() and not line.startswith("...")
    ]
    assert len(lines) <= 2
    assert "Results truncated to 2 lines" in result.message


async def test_grep_output_truncation(grep_tool: Grep):
    """Ensure extremely long output is truncated automatically."""
    with tempfile.TemporaryDirectory() as temp_dir:
        test_file = Path(temp_dir) / "big.txt"
        test_file.write_text(
            "match line with filler content that keeps growing for truncation purposes\n" * 2000
        )

        result = await grep_tool(
            Params.model_validate(
                {
                    "pattern": "match",
                    "path": temp_dir,
                    "output_mode": "content",
                    "head_limit": 0,
                    "-n": True,
                }
            )
        )

        assert not result.is_error
        assert isinstance(result.output, str)
        assert result.message == snapshot("Output is truncated to fit in the message.")
        assert len(result.output) < DEFAULT_MAX_CHARS + 100


async def test_grep_multiline_mode(grep_tool: Grep):
    """Test multiline pattern matching."""
    with tempfile.TemporaryDirectory() as temp_dir:
        # Create a file with multiline content
        test_file = Path(temp_dir) / "multiline.py"
        test_file.write_text(
            """def function():
    '''This is a
    multiline docstring'''
    pass
""",
            newline="\n",
        )

        # Test multiline pattern
        result = await grep_tool(
            Params(
                pattern=r"This is a\n    multiline",
                path=temp_dir,
                output_mode="content",
                multiline=True,
            )
        )
        assert not result.is_error
        assert isinstance(result.output, str)

        # Should find the multiline pattern
        assert "This is a" in result.output
        assert "multiline" in result.output


async def test_grep_no_matches(grep_tool: Grep):
    """Test when no matches are found."""
    with tempfile.TemporaryDirectory() as temp_dir:
        test_file = Path(temp_dir) / "empty.py"
        test_file.write_text("# This file has no matching content\n")

        result = await grep_tool(
            Params(pattern="nonexistent_pattern", path=temp_dir, output_mode="files_with_matches")
        )
        assert not result.is_error
        assert result.output == ""
        assert "No matches found" in result.message


async def test_grep_invalid_pattern(grep_tool: Grep):
    """Test with invalid regex pattern."""
    result = await grep_tool(Params(pattern="[invalid", path=".", output_mode="files_with_matches"))
    assert result.is_error
    assert "Failed to grep" in result.message


async def test_grep_single_file(grep_tool: Grep):
    """Test searching in a single file."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py") as f:
        f.write("def test_function():\n    return 'hello world'\n")
        f.flush()

        result = await grep_tool(
            Params.model_validate(
                {
                    "pattern": "hello",
                    "path": f.name,
                    "output_mode": "content",
                    "-n": True,
                }
            )
        )
        assert not result.is_error
        assert isinstance(result.output, str)

        assert "hello" in result.output
        # For single file search, filename might not be in content output
        # Let's just check that we got valid content
        assert len(result.output.strip()) > 0


async def test_grep_before_after_context(grep_tool: Grep, temp_test_files):
    """Test before and after context separately."""
    temp_dir, test_files = temp_test_files

    # Test before context
    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "TestClass",
                "path": temp_dir,
                "output_mode": "content",
                "-B": 2,
                "-n": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)
    assert "TestClass" in result.output
    assert "}" in result.output
    assert 'return "hello"' in result.output
    assert "Hello, World!" not in result.output

    # Test after context
    result = await grep_tool(
        Params.model_validate(
            {
                "pattern": "TestClass",
                "path": temp_dir,
                "output_mode": "content",
                "-A": 2,
                "-n": True,
            }
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)
    assert "TestClass" in result.output
    assert "constructor()" in result.output
    assert "this.message" in result.output
    assert "}" not in result.output


# === Tests for new features ===


async def test_grep_default_head_limit(grep_tool: Grep):
    """Default head_limit=250 truncates large result sets."""
    with tempfile.TemporaryDirectory() as temp_dir:
        for i in range(300):
            (Path(temp_dir) / f"file_{i:03d}.txt").write_text("marker\n")

        result = await grep_tool(
            Params(pattern="marker", path=temp_dir, output_mode="files_with_matches")
        )
        assert not result.is_error
        assert isinstance(result.output, str)
        lines = [x for x in result.output.split("\n") if x.strip()]
        assert len(lines) == 250
        assert "Results truncated to 250 lines" in result.message
        assert "total: 300" in result.message
        assert "Use offset=250 to see more" in result.message


async def test_grep_head_limit_zero_unlimited(grep_tool: Grep):
    """head_limit=0 returns all results without truncation."""
    with tempfile.TemporaryDirectory() as temp_dir:
        for i in range(300):
            (Path(temp_dir) / f"file_{i:03d}.txt").write_text("marker\n")

        result = await grep_tool(
            Params(pattern="marker", path=temp_dir, output_mode="files_with_matches", head_limit=0)
        )
        assert not result.is_error
        assert isinstance(result.output, str)
        lines = [x for x in result.output.split("\n") if x.strip()]
        assert len(lines) == 300
        assert "truncated" not in result.message.lower()


async def test_grep_offset_pagination(grep_tool: Grep):
    """offset skips the first N results; combined with head_limit enables pagination."""
    with tempfile.TemporaryDirectory() as temp_dir:
        # Use a single file with many lines to avoid mtime sort instability
        (Path(temp_dir) / "data.txt").write_text(
            "\n".join(f"line{i} word" for i in range(10)) + "\n"
        )

        # Page 1: first 3
        r1 = await grep_tool(
            Params(
                pattern="word",
                path=temp_dir,
                output_mode="content",
                head_limit=3,
                offset=0,
            )
        )
        assert isinstance(r1.output, str)
        lines1 = [x for x in r1.output.split("\n") if x.strip()]
        assert len(lines1) == 3
        assert "Use offset=3 to see more" in r1.message

        # Page 2: next 3
        r2 = await grep_tool(
            Params(
                pattern="word",
                path=temp_dir,
                output_mode="content",
                head_limit=3,
                offset=3,
            )
        )
        assert isinstance(r2.output, str)
        lines2 = [x for x in r2.output.split("\n") if x.strip()]
        assert len(lines2) == 3
        # No overlap between pages (content mode has stable line order)
        assert set(lines1).isdisjoint(set(lines2))


async def test_grep_offset_content_mode(grep_tool: Grep):
    """offset works correctly with content mode output."""
    with tempfile.TemporaryDirectory() as temp_dir:
        (Path(temp_dir) / "a.txt").write_text("\n".join(f"line{i} match" for i in range(10)) + "\n")

        # Get all results
        r_all = await grep_tool(
            Params(pattern="match", path=temp_dir, output_mode="content", head_limit=0)
        )
        assert isinstance(r_all.output, str)
        all_lines = [x for x in r_all.output.split("\n") if x.strip()]
        assert len(all_lines) == 10

        # Get with offset=5
        r_offset = await grep_tool(
            Params(
                pattern="match",
                path=temp_dir,
                output_mode="content",
                head_limit=3,
                offset=5,
            )
        )
        assert isinstance(r_offset.output, str)
        offset_lines = [x for x in r_offset.output.split("\n") if x.strip()]
        assert len(offset_lines) == 3
        # Should be lines 5,6,7 from original
        assert offset_lines[0] == all_lines[5]
        assert offset_lines[2] == all_lines[7]


async def test_grep_offset_beyond_results(grep_tool: Grep):
    """offset larger than total results returns no matches."""
    with tempfile.TemporaryDirectory() as temp_dir:
        (Path(temp_dir) / "only.txt").write_text("data\n")

        result = await grep_tool(
            Params(
                pattern="data",
                path=temp_dir,
                output_mode="files_with_matches",
                offset=100,
            )
        )
        assert not result.is_error
        assert "No matches found" in result.message


async def test_grep_hidden_files(grep_tool: Grep):
    """Hidden dotfiles (non-sensitive) are searchable."""
    with tempfile.TemporaryDirectory() as temp_dir:
        (Path(temp_dir) / ".eslintrc.json").write_text('{"rule": "marker"}\n')
        (Path(temp_dir) / "visible.txt").write_text("marker\n")

        result = await grep_tool(
            Params(pattern="marker", path=temp_dir, output_mode="files_with_matches")
        )
        assert not result.is_error
        assert ".eslintrc.json" in result.output
        assert "visible.txt" in result.output


async def test_grep_vcs_exclusion(grep_tool: Grep):
    """.git directory is excluded from search."""
    with tempfile.TemporaryDirectory() as temp_dir:
        git_dir = Path(temp_dir) / ".git"
        git_dir.mkdir()
        (git_dir / "config").write_text("vcs_marker\n")
        (Path(temp_dir) / "real.txt").write_text("vcs_marker\n")

        result = await grep_tool(
            Params(pattern="vcs_marker", path=temp_dir, output_mode="files_with_matches")
        )
        assert not result.is_error
        assert "real.txt" in result.output
        assert ".git" not in result.output


async def test_grep_mtime_sorting(grep_tool: Grep):
    """files_with_matches returns most recently modified files first."""
    import os as _os
    import time

    with tempfile.TemporaryDirectory() as temp_dir:
        old_file = Path(temp_dir) / "old.txt"
        old_file.write_text("sortme\n")
        old_mtime = time.time() - 100
        _os.utime(old_file, (old_mtime, old_mtime))

        new_file = Path(temp_dir) / "new.txt"
        new_file.write_text("sortme\n")

        result = await grep_tool(
            Params(pattern="sortme", path=temp_dir, output_mode="files_with_matches")
        )
        assert not result.is_error
        assert isinstance(result.output, str)
        lines = [x for x in result.output.split("\n") if x.strip()]
        assert len(lines) == 2
        assert lines[0] == "new.txt"
        assert lines[1] == "old.txt"


@pytest.mark.parametrize("output_mode", ["files_with_matches", "content", "count_matches"])
async def test_grep_relative_paths(grep_tool: Grep, temp_test_files, output_mode: str):
    """All output modes return relative paths, not absolute."""
    temp_dir, _ = temp_test_files

    result = await grep_tool(
        Params.model_validate(
            {"pattern": "hello", "path": temp_dir, "output_mode": output_mode, "-i": True}
        )
    )
    assert not result.is_error
    assert isinstance(result.output, str)
    for line in result.output.split("\n"):
        if not line.strip():
            continue
        # For content/count, check the path part before first ':'
        if output_mode in ("content", "count_matches") and ":" in line:
            path_part = line.split(":")[0]
        else:
            path_part = line
        assert not Path(path_part).is_absolute(), f"Expected relative path, got: {line}"


async def test_grep_content_default_line_numbers(grep_tool: Grep):
    """content mode includes line numbers by default (without explicit -n)."""
    with tempfile.TemporaryDirectory() as temp_dir:
        (Path(temp_dir) / "a.txt").write_text("hello\nworld\n")

        result = await grep_tool(Params(pattern="hello", path=temp_dir, output_mode="content"))
        assert not result.is_error
        assert isinstance(result.output, str)
        for line in result.output.split("\n"):
            if line.strip() and not line.startswith("--"):
                parts = line.split(":")
                assert len(parts) >= 3, f"Expected path:line:content, got: {line}"
                assert parts[1].strip().isdigit(), f"Expected line number, got: {parts[1]}"


async def test_grep_content_disable_line_numbers(grep_tool: Grep):
    """content mode can opt-out of line numbers with -n=false."""
    with tempfile.TemporaryDirectory() as temp_dir:
        (Path(temp_dir) / "a.txt").write_text("hello\nworld\n")

        result = await grep_tool(
            Params.model_validate(
                {"pattern": "hello", "path": temp_dir, "output_mode": "content", "-n": False}
            )
        )
        assert not result.is_error
        assert isinstance(result.output, str)
        for line in result.output.split("\n"):
            if line.strip() and not line.startswith("--"):
                parts = line.split(":")
                # path:content (2 parts), NOT path:linenum:content (3 parts)
                assert len(parts) == 2, f"Expected path:content without linenum, got: {line}"


async def test_grep_count_summary(grep_tool: Grep):
    """count_matches: summary in message (not output), accurate on full results."""
    with tempfile.TemporaryDirectory() as temp_dir:
        for i in range(10):
            (Path(temp_dir) / f"f{i}.txt").write_text("word\nword\nword\n")

        result = await grep_tool(
            Params(pattern="word", path=temp_dir, output_mode="count_matches", head_limit=3)
        )
        assert not result.is_error
        assert isinstance(result.output, str)

        # Output is pure path:count (no summary text)
        output_lines = [x for x in result.output.split("\n") if x.strip()]
        assert len(output_lines) == 3
        for line in output_lines:
            assert "Found" not in line, f"Summary leaked into output: {line}"

        # Summary in message reflects ALL 10 files x 3 matches = 30
        assert "Found 30 total occurrences across 10 files" in result.message
        # Pagination info also present
        assert "Results truncated to 3 lines" in result.message


async def test_grep_content_with_context_lines(grep_tool: Grep):
    """content mode with context: both match and context lines have relative paths."""
    with tempfile.TemporaryDirectory() as temp_dir:
        (Path(temp_dir) / "a.txt").write_text("aaa\nbbb\nccc\n")

        result = await grep_tool(
            Params.model_validate(
                {"pattern": "bbb", "path": temp_dir, "output_mode": "content", "-C": 1}
            )
        )
        assert not result.is_error
        assert isinstance(result.output, str)
        assert "bbb" in result.output
        # ALL lines (match and context) should have relative paths
        for line in result.output.split("\n"):
            if line.strip() and line != "--":
                assert not Path(line).is_absolute(), f"Line has absolute path: {line}"


async def test_grep_single_file_relative_path(grep_tool: Grep):
    """Searching a single file still returns relative paths."""
    with tempfile.TemporaryDirectory() as temp_dir:
        test_file = Path(temp_dir) / "target.py"
        test_file.write_text("def foo():\n    pass\n")

        result = await grep_tool(Params(pattern="foo", path=str(test_file), output_mode="content"))
        assert not result.is_error
        assert isinstance(result.output, str)
        for line in result.output.split("\n"):
            if line.strip() and not line.startswith("--"):
                assert not Path(line).is_absolute(), f"Expected relative path, got: {line}"


# === Unit tests for internal functions ===


def test_build_rg_args_defaults():
    """Default mode (files_with_matches): fixed params and output mode flag."""
    args = _build_rg_args("/usr/bin/rg", Params(pattern="test", path="/tmp"))

    # Fixed params always present
    assert "--hidden" in args
    assert "--max-columns" in args
    for vcs in (".git", ".svn", ".hg", ".bzr", ".jj", ".sl"):
        assert f"!{vcs}" in args

    # Default output mode flag
    assert "--files-with-matches" in args

    # content mode: no --max-columns, no --files-with-matches
    content_args = _build_rg_args(
        "/usr/bin/rg", Params(pattern="x", path="/tmp", output_mode="content")
    )
    assert "--max-columns" not in content_args
    assert "--files-with-matches" not in content_args

    # count_matches mode: has --count-matches
    count_args = _build_rg_args(
        "/usr/bin/rg", Params(pattern="x", path="/tmp", output_mode="count_matches")
    )
    assert "--count-matches" in count_args
    assert "--max-columns" in count_args


def test_build_rg_args_flag_mapping():
    """Verify param-to-flag mapping, single_threaded, and expanduser."""
    # All content flags
    params = Params.model_validate(
        {
            "pattern": "test",
            "path": "/tmp",
            "output_mode": "content",
            "-i": True,
            "multiline": True,
            "-B": 2,
            "-A": 3,
            "-C": 1,
            "-n": True,
            "glob": "*.py",
            "type": "py",
        }
    )
    args = _build_rg_args("/usr/bin/rg", params)

    assert "--ignore-case" in args
    assert "--multiline" in args
    assert "--multiline-dotall" in args
    assert "--before-context" in args
    assert "--after-context" in args
    assert "--context" in args
    assert "--line-number" in args
    assert "--glob" in args
    assert "--type" in args
    # Pattern and path after --
    dd_idx = args.index("--")
    assert args[dd_idx + 1] == "test"
    assert args[dd_idx + 2] == "/tmp"

    # single_threaded adds -j 1
    st_args = _build_rg_args("/usr/bin/rg", Params(pattern="x", path="/tmp"), single_threaded=True)
    idx = st_args.index("-j")
    assert st_args[idx + 1] == "1"

    # expanduser expands ~ in path
    tilde_args = _build_rg_args("/usr/bin/rg", Params(pattern="x", path="~/foo"))
    assert not tilde_args[-1].startswith("~")
    assert "foo" in tilde_args[-1]


def test_strip_path_prefix_posix():
    """Prefix stripping works with POSIX paths (forward slash)."""
    output = "/home/user/project/src/a.py:42:code\n/home/user/project/src/b.py-41-context\n--\n"
    result = _strip_path_prefix(output, "/home/user/project")
    lines = result.split("\n")
    assert lines[0] == "src/a.py:42:code"
    assert lines[1] == "src/b.py-41-context"
    assert lines[2] == "--"
    assert lines[3] == ""


def test_strip_path_prefix_windows(monkeypatch):
    """Prefix stripping works with Windows paths (backslash)."""
    monkeypatch.setattr("kimi_cli.tools.file.grep_local.os.sep", "\\")

    output = "C:\\repo\\src\\a.py:42:code\nC:\\repo\\src\\b.py-41-context\n--\n"
    result = _strip_path_prefix(output, "C:\\repo")
    lines = result.split("\n")
    assert lines[0] == "src\\a.py:42:code"
    assert lines[1] == "src\\b.py-41-context"
    assert lines[2] == "--"
    assert lines[3] == ""


def test_strip_path_prefix_no_match():
    """Lines not starting with prefix are kept as-is."""
    output = "/other/path/file.py\n--\n"
    result = _strip_path_prefix(output, "/home/user/project")
    assert result == "/other/path/file.py\n--\n"


def test_strip_path_prefix_trailing_sep():
    """Trailing separators on search_base are handled correctly."""
    output = "/tmp/dir/file.py\n"
    # With trailing slash
    assert _strip_path_prefix(output, "/tmp/dir/") == "file.py\n"
    # Without trailing slash
    assert _strip_path_prefix(output, "/tmp/dir") == "file.py\n"


def test_strip_path_prefix_similar_names():
    """search_base=/tmp/a must not match /tmp/abc/file.py."""
    output = "/tmp/abc/file.py\n/tmp/a/file.py\n"
    result = _strip_path_prefix(output, "/tmp/a")
    lines = result.split("\n")
    assert lines[0] == "/tmp/abc/file.py"  # NOT stripped
    assert lines[1] == "file.py"  # stripped


# === Tests for include_ignored feature ===


async def test_grep_include_ignored_finds_gitignored_files(grep_tool: Grep):
    """include_ignored=True should find files that are listed in .gitignore."""
    with tempfile.TemporaryDirectory() as temp_dir:
        # Set up a git repo with .gitignore
        import subprocess

        subprocess.run(["git", "init", "-q", temp_dir], check=True)
        (Path(temp_dir) / ".git" / "test_marker").write_text("SECRET=leaked\n")
        # Use a non-sensitive ignored file (build output) to test include_ignored
        (Path(temp_dir) / ".gitignore").write_text("build.log\n")
        (Path(temp_dir) / "build.log").write_text("SECRET=in_build_log\n")
        (Path(temp_dir) / "visible.txt").write_text("SECRET=visible\n")

        # Without include_ignored: build.log should be excluded
        result = await grep_tool(
            Params(pattern="SECRET", path=temp_dir, output_mode="files_with_matches")
        )
        assert not result.is_error
        assert "visible.txt" in result.output
        assert "build.log" not in result.output

        # With include_ignored: build.log should be found
        result = await grep_tool(
            Params(
                pattern="SECRET",
                path=temp_dir,
                output_mode="files_with_matches",
                include_ignored=True,
            )
        )
        assert not result.is_error
        assert "build.log" in result.output
        assert "visible.txt" in result.output
        assert ".git" not in result.output  # VCS directories still excluded


async def test_grep_include_ignored_default_false(grep_tool: Grep):
    """By default, include_ignored should be False (respect .gitignore)."""
    params = Params(pattern="test", path="/tmp")
    assert params.include_ignored is False


def test_build_rg_args_include_ignored():
    """include_ignored=True should add --no-ignore flag to rg args."""
    params = Params(pattern="test", path="/tmp", include_ignored=True)
    args = _build_rg_args("/usr/bin/rg", params)
    assert "--no-ignore" in args

    # Default: no --no-ignore
    params_default = Params(pattern="test", path="/tmp")
    args_default = _build_rg_args("/usr/bin/rg", params_default)
    assert "--no-ignore" not in args_default


async def test_grep_filters_sensitive_files_always(grep_tool: Grep):
    """Sensitive files (.env, SSH keys) are always filtered, even without include_ignored."""
    with tempfile.TemporaryDirectory() as temp_dir:
        # No git repo — .env is not gitignored, just a normal dotfile
        (Path(temp_dir) / ".env").write_text("SECRET=hunter2\n")
        (Path(temp_dir) / "id_rsa").write_text("SECRET=private_key\n")
        (Path(temp_dir) / "visible.txt").write_text("SECRET=visible\n")

        result = await grep_tool(
            Params(pattern="SECRET", path=temp_dir, output_mode="files_with_matches")
        )
        assert not result.is_error
        assert "visible.txt" in result.output
        assert ".env" not in result.output
        assert "id_rsa" not in result.output
        assert "sensitive" in result.message.lower()


async def test_grep_filters_sensitive_in_content_mode(grep_tool: Grep):
    """Sensitive file filtering works in content output mode."""
    with tempfile.TemporaryDirectory() as temp_dir:
        (Path(temp_dir) / ".env").write_text("SECRET=hunter2\n")
        (Path(temp_dir) / "visible.txt").write_text("SECRET=visible\n")

        result = await grep_tool(Params(pattern="SECRET", path=temp_dir, output_mode="content"))
        assert not result.is_error
        assert "visible.txt" in result.output
        assert ".env" not in result.output
        assert "sensitive" in result.message.lower()


async def test_grep_filters_sensitive_context_lines(grep_tool: Grep):
    """Context lines (ripgrep -C) for sensitive files must also be filtered."""
    with tempfile.TemporaryDirectory() as temp_dir:
        (Path(temp_dir) / ".env").write_text("line1\nSECRET=hunter2\nline3\n")
        (Path(temp_dir) / "visible.txt").write_text("lineA\nSECRET=visible\nlineC\n")

        result = await grep_tool(
            Params.model_validate(
                {"pattern": "SECRET", "path": temp_dir, "output_mode": "content", "-C": 1}
            )
        )
        assert not result.is_error
        assert "visible.txt" in result.output
        # Neither match lines nor context lines from .env should appear
        assert ".env" not in result.output
        assert "hunter2" not in result.output
        assert "sensitive" in result.message.lower()


async def test_grep_filters_sensitive_hyphenated_path(grep_tool: Grep):
    """Sensitive file in a hyphenated directory should be correctly filtered in content mode."""
    with tempfile.TemporaryDirectory() as temp_dir:
        sub = Path(temp_dir) / "my-project"
        sub.mkdir()
        (sub / ".env").write_text("SECRET=leaked\n")
        (Path(temp_dir) / "safe.txt").write_text("SECRET=ok\n")

        result = await grep_tool(
            Params.model_validate(
                {"pattern": "SECRET", "path": temp_dir, "output_mode": "content", "-C": 1}
            )
        )
        assert not result.is_error
        assert "safe.txt" in result.output
        assert ".env" not in result.output
        assert "leaked" not in result.output


async def test_grep_all_sensitive_preserves_warning(grep_tool: Grep):
    """When all results are sensitive, warning should not be lost to 'No matches found'."""
    with tempfile.TemporaryDirectory() as temp_dir:
        (Path(temp_dir) / ".env").write_text("ONLY_IN_ENV=secret\n")

        result = await grep_tool(
            Params(pattern="ONLY_IN_ENV", path=temp_dir, output_mode="files_with_matches")
        )
        assert not result.is_error
        assert "No matches found" in result.message
        assert "sensitive" in result.message.lower()
        assert ".env" in result.message


async def test_grep_allows_env_example(grep_tool: Grep):
    """.env.example is not sensitive and should appear in results."""
    with tempfile.TemporaryDirectory() as temp_dir:
        (Path(temp_dir) / ".env.example").write_text("API_KEY=placeholder\n")

        result = await grep_tool(
            Params(pattern="API_KEY", path=temp_dir, output_mode="files_with_matches")
        )
        assert not result.is_error
        assert ".env.example" in result.output

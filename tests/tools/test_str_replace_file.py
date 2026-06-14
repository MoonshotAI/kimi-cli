"""Tests for the str_replace_file tool."""

from __future__ import annotations

from pathlib import Path

from kaos.path import KaosPath

from kimi_cli.tools.file.replace import Edit, Params, StrReplaceFile
from kimi_cli.wire.types import DiffDisplayBlock


async def test_replace_single_occurrence(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing a single occurrence."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world! This is a test."
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(path=str(file_path), edit=Edit(old="world", new="universe"))
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    diff_block = next(block for block in result.display if block.type == "diff")
    assert isinstance(diff_block, DiffDisplayBlock)
    assert diff_block.path == str(file_path)
    assert diff_block.old_text == original_content
    assert diff_block.new_text == "Hello universe! This is a test."
    assert await file_path.read_text() == "Hello universe! This is a test."


async def test_replace_all_occurrences(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing all occurrences."""
    file_path = temp_work_dir / "test.txt"
    original_content = "apple banana apple cherry apple"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(
            path=str(file_path),
            edit=Edit(old="apple", new="fruit", replace_all=True),
        )
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "fruit banana fruit cherry fruit"


async def test_replace_multiple_edits(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test applying multiple edits."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world! Goodbye world!"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(
            path=str(file_path),
            edit=[
                Edit(old="Hello", new="Hi"),
                Edit(old="Goodbye", new="See you"),
            ],
        )
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "Hi world! See you world!"


async def test_replace_multiline_content(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing multi-line content."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Line 1\nLine 2\nLine 3\n"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(
            path=str(file_path),
            edit=Edit(old="Line 2\nLine 3", new="Modified line 2\nModified line 3"),
        )
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "Line 1\nModified line 2\nModified line 3\n"


async def test_replace_unicode_content(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing unicode content."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello 世界! café"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(path=str(file_path), edit=Edit(old="世界", new="地球"))
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "Hello 地球! café"


async def test_replace_no_match(str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath):
    """Test replacing when the old string is not found."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world!"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(path=str(file_path), edit=Edit(old="notfound", new="replacement"))
    )

    assert result.is_error
    assert "No replacements were made" in result.message
    assert await file_path.read_text() == original_content  # Content unchanged


async def test_replace_with_relative_path(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing with a relative path inside the work directory."""
    relative_dir = temp_work_dir / "relative" / "path"
    await relative_dir.mkdir(parents=True, exist_ok=True)
    file_path = relative_dir / "file.txt"
    await file_path.write_text("old content")

    result = await str_replace_file_tool(
        Params(path="relative/path/file.txt", edit=Edit(old="old", new="new"))
    )

    assert not result.is_error
    assert await file_path.read_text() == "new content"


async def test_replace_outside_work_directory(
    str_replace_file_tool: StrReplaceFile, outside_file: Path
):
    """Test replacing outside the working directory with an absolute path."""
    outside_file.write_text("old content", encoding="utf-8")

    result = await str_replace_file_tool(
        Params(path=str(outside_file), edit=Edit(old="old", new="new"))
    )

    assert not result.is_error
    assert outside_file.read_text(encoding="utf-8") == "new content"


async def test_replace_outside_work_directory_with_prefix(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Paths sharing the work dir prefix but outside should still be editable
    with absolute paths."""
    base = Path(str(temp_work_dir))
    sneaky_dir = base.parent / f"{base.name}-sneaky"
    sneaky_dir.mkdir(parents=True, exist_ok=True)
    sneaky_file = sneaky_dir / "test.txt"
    sneaky_file.write_text("content", encoding="utf-8")

    result = await str_replace_file_tool(
        Params(path=str(sneaky_file), edit=Edit(old="content", new="new"))
    )

    assert not result.is_error
    assert sneaky_file.read_text() == "new"


async def test_replace_nonexistent_file(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing in a non-existent file."""
    file_path = temp_work_dir / "nonexistent.txt"

    result = await str_replace_file_tool(
        Params(path=str(file_path), edit=Edit(old="old", new="new"))
    )

    assert result.is_error
    assert "does not exist" in result.message


async def test_replace_directory_instead_of_file(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing in a directory instead of a file."""
    dir_path = temp_work_dir / "directory"
    await dir_path.mkdir()

    result = await str_replace_file_tool(
        Params(path=str(dir_path), edit=Edit(old="old", new="new"))
    )

    assert result.is_error
    assert "is not a file" in result.message


async def test_replace_mixed_multiple_edits(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test multiple edits with different replace_all settings."""
    file_path = temp_work_dir / "test.txt"
    original_content = "apple apple banana apple cherry"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(
            path=str(file_path),
            edit=[
                Edit(old="apple", new="fruit", replace_all=False),  # Only first occurrence
                Edit(
                    old="banana", new="tasty", replace_all=True
                ),  # All occurrences (though only one)
            ],
        )
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "fruit apple tasty apple cherry"


async def test_replace_empty_strings(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Test replacing with empty strings."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world!"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(path=str(file_path), edit=Edit(old="world", new=""))
    )

    assert not result.is_error
    assert "successfully edited" in result.message
    assert await file_path.read_text() == "Hello !"


async def test_replace_multiple_edits_one_not_found_is_atomic(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """A multi-edit where one edit's old string is missing must fail the whole
    call, not silently apply the matching edits and report success."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world! Goodbye world!"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(
            path=str(file_path),
            edit=[
                Edit(old="Hello", new="Hi"),
                Edit(old="does-not-exist", new="x"),
            ],
        )
    )

    assert result.is_error
    assert "No replacements were made" in result.message
    # The whole batch fails atomically — the file is left untouched even though
    # the first edit on its own would have matched.
    assert await file_path.read_text() == original_content


async def test_replace_sequential_dependent_edits_count(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """Edits apply in sequence, so a later edit can target text an earlier edit
    introduced, and the reported replacement count reflects what actually ran."""
    file_path = temp_work_dir / "test.txt"
    await file_path.write_text("foo")

    result = await str_replace_file_tool(
        Params(
            path=str(file_path),
            edit=[
                Edit(old="foo", new="bar"),
                Edit(old="bar", new="baz"),
            ],
        )
    )

    assert not result.is_error
    assert await file_path.read_text() == "baz"
    assert "2 total replacement(s)" in result.message


async def test_replace_noop_reports_unchanged_not_missing(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """An edit whose old string equals its new string matches but changes
    nothing. The error must say the file was left unchanged, not the misleading
    "old string was not found" (which would send the model re-reading the file
    for a string that is actually present)."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world!"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(
        Params(path=str(file_path), edit=Edit(old="world", new="world"))
    )

    assert result.is_error
    assert "left the file unchanged" in result.message
    assert "not found" not in result.message
    assert await file_path.read_text() == original_content


async def test_replace_rejects_empty_old_string(
    str_replace_file_tool: StrReplaceFile, temp_work_dir: KaosPath
):
    """An empty old string must be rejected. `str.count('')` is never 0 and
    `str.replace('', new)` would splice new between every character, so the
    occurrence check cannot guard it — reject it explicitly instead."""
    file_path = temp_work_dir / "test.txt"
    original_content = "Hello world!"
    await file_path.write_text(original_content)

    result = await str_replace_file_tool(Params(path=str(file_path), edit=Edit(old="", new="X")))

    assert result.is_error
    assert "must not be empty" in result.message
    assert await file_path.read_text() == original_content

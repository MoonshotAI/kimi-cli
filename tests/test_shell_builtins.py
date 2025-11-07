"""Tests for built-in shell commands."""

import os
from pathlib import Path

import pytest

from kimi_cli.ui.shell.builtins import handle_builtin_command


@pytest.mark.asyncio
async def test_cd_to_existing_directory(tmp_path):
    """Test cd to an existing directory."""
    # Create a test directory
    test_dir = tmp_path / "test_dir"
    test_dir.mkdir()

    # Save original directory
    original_dir = Path.cwd()

    try:
        # Change to tmp_path first
        os.chdir(tmp_path)

        # Test cd to the test directory
        result = await handle_builtin_command(f"cd {test_dir}")
        assert result.handled is True
        assert result.success is True
        assert Path.cwd() == test_dir

    finally:
        # Restore original directory
        os.chdir(original_dir)


@pytest.mark.asyncio
async def test_cd_to_nonexistent_directory(tmp_path):
    """Test cd to a non-existent directory."""
    original_dir = Path.cwd()

    try:
        os.chdir(tmp_path)

        # Test cd to non-existent directory
        result = await handle_builtin_command("cd nonexistent_dir")
        assert result.handled is True
        assert result.success is False
        # Directory should not have changed
        assert Path.cwd() == tmp_path

    finally:
        os.chdir(original_dir)


@pytest.mark.asyncio
async def test_cd_to_home_directory():
    """Test cd with no arguments (should go to home)."""
    original_dir = Path.cwd()

    try:
        # Test cd with no arguments
        result = await handle_builtin_command("cd")
        assert result.handled is True
        assert result.success is True
        assert Path.cwd() == Path.home()

    finally:
        os.chdir(original_dir)


@pytest.mark.asyncio
async def test_cd_with_tilde():
    """Test cd with tilde expansion."""
    original_dir = Path.cwd()

    try:
        # Test cd ~
        result = await handle_builtin_command("cd ~")
        assert result.handled is True
        assert result.success is True
        assert Path.cwd() == Path.home()

    finally:
        os.chdir(original_dir)


@pytest.mark.asyncio
async def test_cd_relative_path(tmp_path):
    """Test cd with relative path."""
    # Create nested directories
    parent_dir = tmp_path / "parent"
    child_dir = parent_dir / "child"
    child_dir.mkdir(parents=True)

    original_dir = Path.cwd()

    try:
        # Change to parent directory
        os.chdir(parent_dir)

        # Test cd to relative path
        result = await handle_builtin_command("cd child")
        assert result.handled is True
        assert result.success is True
        assert Path.cwd() == child_dir

        # Test cd ..
        result = await handle_builtin_command("cd ..")
        assert result.handled is True
        assert result.success is True
        assert Path.cwd() == parent_dir

    finally:
        os.chdir(original_dir)


@pytest.mark.asyncio
async def test_cd_to_file_fails(tmp_path):
    """Test cd to a file (should fail)."""
    # Create a test file
    test_file = tmp_path / "test_file.txt"
    test_file.write_text("test")

    original_dir = Path.cwd()

    try:
        os.chdir(tmp_path)

        # Test cd to a file
        result = await handle_builtin_command(f"cd {test_file}")
        assert result.handled is True
        assert result.success is False
        # Directory should not have changed
        assert Path.cwd() == tmp_path

    finally:
        os.chdir(original_dir)


@pytest.mark.asyncio
async def test_pwd():
    """Test pwd command."""
    current_dir = Path.cwd()

    # Test pwd
    result = await handle_builtin_command("pwd")
    assert result.handled is True
    assert result.success is True
    # pwd should not change the directory
    assert Path.cwd() == current_dir


@pytest.mark.asyncio
async def test_non_builtin_command():
    """Test that non-builtin commands are not handled."""
    result = await handle_builtin_command("ls -la")
    assert result.handled is False

    result = await handle_builtin_command("echo hello")
    assert result.handled is False

    result = await handle_builtin_command("git status")
    assert result.handled is False


@pytest.mark.asyncio
async def test_cd_with_spaces_in_path(tmp_path):
    """Test cd with spaces in directory name."""
    # Create a directory with spaces
    test_dir = tmp_path / "test dir with spaces"
    test_dir.mkdir()

    original_dir = Path.cwd()

    try:
        os.chdir(tmp_path)

        # Test cd with quoted path
        result = await handle_builtin_command(f'cd "{test_dir}"')
        assert result.handled is True
        assert result.success is True
        assert Path.cwd() == test_dir

    finally:
        os.chdir(original_dir)


@pytest.mark.asyncio
async def test_empty_command():
    """Test empty command."""
    result = await handle_builtin_command("")
    assert result.handled is False

    result = await handle_builtin_command("   ")
    assert result.handled is False

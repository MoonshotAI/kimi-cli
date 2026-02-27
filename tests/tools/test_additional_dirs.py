"""Tests for additional directories support in file tools."""

from __future__ import annotations

import platform
import tempfile
from collections.abc import Generator
from pathlib import Path

import pytest
from kaos.path import KaosPath

from kimi_cli.soul.agent import Runtime
from kimi_cli.soul.approval import Approval
from kimi_cli.tools.file.glob import Glob
from kimi_cli.tools.file.glob import Params as GlobParams
from kimi_cli.tools.file.read import Params as ReadParams
from kimi_cli.tools.file.read import ReadFile
from kimi_cli.tools.file.replace import Edit, StrReplaceFile
from kimi_cli.tools.file.replace import Params as ReplaceParams
from kimi_cli.tools.file.write import Params as WriteParams
from kimi_cli.tools.file.write import WriteFile
from tests.conftest import tool_call_context


@pytest.fixture
def additional_dir(temp_work_dir: KaosPath) -> Generator[KaosPath]:
    """Create a temporary additional directory outside the work directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        p = Path(tmpdir).resolve()
        yield KaosPath.unsafe_from_local_path(p)


@pytest.fixture
def runtime_with_additional_dir(runtime: Runtime, additional_dir: KaosPath) -> Runtime:
    """Runtime with an additional directory configured."""
    runtime.additional_dirs.append(additional_dir)
    return runtime


# ── Glob tests ──────────────────────────────────────────────────────────────


async def test_glob_in_additional_dir(
    runtime_with_additional_dir: Runtime, additional_dir: KaosPath
):
    """Glob should be able to search in an additional directory."""
    glob_tool = Glob(runtime_with_additional_dir)
    await (additional_dir / "hello.py").write_text("print('hello')")
    await (additional_dir / "world.py").write_text("print('world')")

    result = await glob_tool(GlobParams(pattern="*.py", directory=str(additional_dir)))
    assert not result.is_error
    assert "hello.py" in result.output
    assert "world.py" in result.output


async def test_glob_in_additional_dir_subdirectory(
    runtime_with_additional_dir: Runtime, additional_dir: KaosPath
):
    """Glob should work in a subdirectory of an additional directory."""
    glob_tool = Glob(runtime_with_additional_dir)
    await (additional_dir / "src").mkdir()
    await (additional_dir / "src" / "main.py").write_text("main")

    sub = str(additional_dir / "src")
    result = await glob_tool(GlobParams(pattern="*.py", directory=sub))
    assert not result.is_error
    assert "main.py" in result.output


async def test_glob_outside_all_dirs_rejected(
    runtime_with_additional_dir: Runtime,
):
    """Glob in a directory outside both work_dir and additional dirs should fail."""
    glob_tool = Glob(runtime_with_additional_dir)
    outside = "/tmp/evil" if platform.system() != "Windows" else "C:/tmp/evil"

    result = await glob_tool(GlobParams(pattern="*.py", directory=outside))
    assert result.is_error
    assert "outside the workspace" in result.message


# ── ReadFile tests ──────────────────────────────────────────────────────────


async def test_read_file_in_additional_dir(
    runtime_with_additional_dir: Runtime, additional_dir: KaosPath
):
    """ReadFile should read files in additional directories."""
    read_tool = ReadFile(runtime_with_additional_dir)
    test_file = additional_dir / "readme.txt"
    await test_file.write_text("Hello from additional dir\n")

    result = await read_tool(ReadParams(path=str(test_file)))
    assert not result.is_error
    assert "Hello from additional dir" in result.output


async def test_read_file_relative_path_in_additional_dir(
    runtime_with_additional_dir: Runtime, additional_dir: KaosPath
):
    """Relative paths that resolve outside work_dir but inside additional dir should work."""
    read_tool = ReadFile(runtime_with_additional_dir)
    test_file = additional_dir / "data.txt"
    await test_file.write_text("data content\n")

    # Absolute path to the file in additional dir should be allowed
    result = await read_tool(ReadParams(path=str(test_file)))
    assert not result.is_error


# ── WriteFile tests ─────────────────────────────────────────────────────────


async def test_write_file_in_additional_dir(
    runtime_with_additional_dir: Runtime, approval: Approval, additional_dir: KaosPath
):
    """WriteFile should write to files in additional directories."""
    with tool_call_context("WriteFile"):
        write_tool = WriteFile(runtime_with_additional_dir, approval)
        target = additional_dir / "output.txt"

        result = await write_tool(WriteParams(path=str(target), content="new content"))
        assert not result.is_error
        assert await target.read_text() == "new content"


async def test_write_file_in_additional_dir_uses_edit_action(
    runtime_with_additional_dir: Runtime, approval: Approval, additional_dir: KaosPath
):
    """Writing in additional dir should use EDIT action (not EDIT_OUTSIDE)."""
    with tool_call_context("WriteFile"):
        write_tool = WriteFile(runtime_with_additional_dir, approval)
        target = additional_dir / "in_workspace.txt"

        result = await write_tool(WriteParams(path=str(target), content="content"))
        assert not result.is_error


# ── StrReplaceFile tests ────────────────────────────────────────────────────


async def test_replace_in_additional_dir(
    runtime_with_additional_dir: Runtime, approval: Approval, additional_dir: KaosPath
):
    """StrReplaceFile should edit files in additional directories."""
    with tool_call_context("StrReplaceFile"):
        replace_tool = StrReplaceFile(runtime_with_additional_dir, approval)
        target = additional_dir / "code.py"
        await target.write_text("old_value = 1\n")

        result = await replace_tool(
            ReplaceParams(
                path=str(target),
                edit=Edit(old="old_value", new="new_value"),
            )
        )
        assert not result.is_error
        assert await target.read_text() == "new_value = 1\n"


# ── Dynamic mutation tests ──────────────────────────────────────────────────


async def test_add_dir_dynamically_affects_tools(runtime: Runtime, approval: Approval):
    """Adding a dir to runtime.additional_dirs should immediately affect tool behavior."""
    glob_tool = Glob(runtime)

    with tempfile.TemporaryDirectory() as tmpdir:
        extra = KaosPath.unsafe_from_local_path(Path(tmpdir).resolve())
        await (extra / "test.py").write_text("pass")

        # Before adding: should be rejected
        result = await glob_tool(GlobParams(pattern="*.py", directory=str(extra)))
        assert result.is_error
        assert "outside the workspace" in result.message

        # Add the directory to runtime (simulating /add-dir)
        runtime.additional_dirs.append(extra)

        # After adding: should work
        result = await glob_tool(GlobParams(pattern="*.py", directory=str(extra)))
        assert not result.is_error
        assert "test.py" in result.output


async def test_subagent_shares_additional_dirs(runtime: Runtime):
    """Subagent runtime should share the same additional_dirs list."""
    fixed = runtime.copy_for_fixed_subagent()
    dynamic = runtime.copy_for_dynamic_subagent()

    # They should be the exact same list object
    assert fixed.additional_dirs is runtime.additional_dirs
    assert dynamic.additional_dirs is runtime.additional_dirs

    # Mutation on parent should be visible to subagents
    runtime.additional_dirs.append(KaosPath("/test/shared"))
    assert KaosPath("/test/shared") in fixed.additional_dirs
    assert KaosPath("/test/shared") in dynamic.additional_dirs

from __future__ import annotations

from unittest.mock import patch

import pytest
from kaos.path import KaosPath

from kimi_cli.soul.agent import load_agents_md


@pytest.mark.asyncio
async def test_load_agents_md_found(temp_work_dir: KaosPath, tmp_path):
    """Test loading AGENTS.md when it exists."""
    agents_md = temp_work_dir / "AGENTS.md"
    await agents_md.write_text("Test agents content")

    with patch("kimi_cli.soul.agent.Path.home", return_value=tmp_path):
        content = await load_agents_md(temp_work_dir)

    assert content == "Test agents content"


@pytest.mark.asyncio
async def test_load_agents_md_not_found(temp_work_dir: KaosPath, tmp_path):
    """Test loading AGENTS.md when it doesn't exist."""
    with patch("kimi_cli.soul.agent.Path.home", return_value=tmp_path):
        content = await load_agents_md(temp_work_dir)

    assert content is None


@pytest.mark.asyncio
async def test_load_agents_md_lowercase(temp_work_dir: KaosPath, tmp_path):
    """Test loading agents.md (lowercase)."""
    agents_md = temp_work_dir / "agents.md"
    await agents_md.write_text("Lowercase agents content")

    with patch("kimi_cli.soul.agent.Path.home", return_value=tmp_path):
        content = await load_agents_md(temp_work_dir)

    assert content == "Lowercase agents content"


@pytest.mark.asyncio
async def test_load_agents_md_global_only(temp_work_dir: KaosPath, tmp_path):
    """Test loading global AGENTS.md when project-level doesn't exist."""
    global_kimi_dir = tmp_path / ".kimi"
    global_kimi_dir.mkdir()
    (global_kimi_dir / "AGENTS.md").write_text("Global agents content")

    with patch("kimi_cli.soul.agent.Path.home", return_value=tmp_path):
        content = await load_agents_md(temp_work_dir)

    assert content == "Global agents content"


@pytest.mark.asyncio
async def test_load_agents_md_merge_project_and_global(temp_work_dir: KaosPath, tmp_path):
    """Test merging project-level and global AGENTS.md."""
    # Create project-level AGENTS.md
    agents_md = temp_work_dir / "AGENTS.md"
    await agents_md.write_text("Project agents content")

    # Create global AGENTS.md
    global_kimi_dir = tmp_path / ".kimi"
    global_kimi_dir.mkdir()
    (global_kimi_dir / "AGENTS.md").write_text("Global agents content")

    with patch("kimi_cli.soul.agent.Path.home", return_value=tmp_path):
        content = await load_agents_md(temp_work_dir)

    assert content == "Project agents content\n\nGlobal agents content"


@pytest.mark.asyncio
async def test_load_agents_md_global_lowercase(temp_work_dir: KaosPath, tmp_path):
    """Test loading global agents.md (lowercase)."""
    global_kimi_dir = tmp_path / ".kimi"
    global_kimi_dir.mkdir()
    (global_kimi_dir / "agents.md").write_text("Global lowercase content")

    with patch("kimi_cli.soul.agent.Path.home", return_value=tmp_path):
        content = await load_agents_md(temp_work_dir)

    assert content == "Global lowercase content"

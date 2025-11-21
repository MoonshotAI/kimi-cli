from __future__ import annotations

import pytest

from kaos.path import KaosPath
from kimi_cli.soul.agent import load_agents_md


@pytest.mark.asyncio
async def test_load_agents_md_found(temp_work_dir: KaosPath):
    """Test loading AGENTS.md when it exists."""
    agents_md = temp_work_dir / "AGENTS.md"
    await agents_md.write_text("Test agents content")

    content = await load_agents_md(temp_work_dir)

    assert content == "Test agents content"


@pytest.mark.asyncio
async def test_load_agents_md_not_found(temp_work_dir: KaosPath):
    """Test loading AGENTS.md when it doesn't exist."""
    content = await load_agents_md(temp_work_dir)

    assert content is None


@pytest.mark.asyncio
async def test_load_agents_md_lowercase(temp_work_dir: KaosPath):
    """Test loading agents.md (lowercase)."""
    agents_md = temp_work_dir / "agents.md"
    await agents_md.write_text("Lowercase agents content")

    content = await load_agents_md(temp_work_dir)

    assert content == "Lowercase agents content"

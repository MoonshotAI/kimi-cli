from __future__ import annotations

from kaos.path import KaosPath

from gitrekt_cli.soul.agent import load_agents_md


async def test_load_agents_md_found(temp_work_dir: KaosPath):
    """Test loading AGENTS.md when it exists."""
    agents_md = temp_work_dir / "AGENTS.md"
    await agents_md.write_text("Test agents content")

    content = await load_agents_md(temp_work_dir)

    assert content == "Test agents content"


async def test_load_agents_md_not_found(temp_work_dir: KaosPath):
    """Test loading AGENTS.md when it doesn't exist."""
    content = await load_agents_md(temp_work_dir)

    assert content is None


async def test_load_agents_md_lowercase(temp_work_dir: KaosPath):
    """Test loading agents.md (lowercase)."""
    agents_md = temp_work_dir / "agents.md"
    await agents_md.write_text("Lowercase agents content")

    content = await load_agents_md(temp_work_dir)

    assert content == "Lowercase agents content"

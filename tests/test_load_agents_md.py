from __future__ import annotations

from pathlib import Path

from kimi_cli.soul.runtime import load_agents_md


def test_load_agents_md_found(temp_work_dir: Path):
    """Test loading AGENTS.md when it exists."""
    agents_md = temp_work_dir / "AGENTS.md"
    agents_md.write_text("Test agents content")

    content = load_agents_md(temp_work_dir)

    assert content == "Test agents content"


def test_load_agents_md_not_found(temp_work_dir: Path):
    """Test loading AGENTS.md when it doesn't exist."""
    content = load_agents_md(temp_work_dir)

    assert content is None


def test_load_agents_md_lowercase(temp_work_dir: Path):
    """Test loading agents.md (lowercase)."""
    agents_md = temp_work_dir / "agents.md"
    agents_md.write_text("Lowercase agents content")

    content = load_agents_md(temp_work_dir)

    assert content == "Lowercase agents content"

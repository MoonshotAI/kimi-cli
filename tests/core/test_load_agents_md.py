from __future__ import annotations

from kaos.path import KaosPath

from kimi_cli.soul.agent import _AGENTS_MD_MAX_BYTES, load_agents_md

# ---------------------------------------------------------------------------
# Basic loading
# ---------------------------------------------------------------------------


async def test_found(temp_work_dir: KaosPath):
    """AGENTS.md in work_dir is loaded with source annotation."""
    await (temp_work_dir / "AGENTS.md").write_text("Test agents content")

    content = await load_agents_md(temp_work_dir)

    assert content is not None
    assert "Test agents content" in content
    assert "<!-- From:" in content
    assert content.count("<!-- From:") == 1


async def test_not_found(temp_work_dir: KaosPath):
    """No AGENTS.md anywhere returns None."""
    content = await load_agents_md(temp_work_dir)

    assert content is None


async def test_lowercase(temp_work_dir: KaosPath):
    """agents.md (lowercase) is loaded."""
    await (temp_work_dir / "agents.md").write_text("Lowercase agents content")

    content = await load_agents_md(temp_work_dir)

    assert content is not None
    assert "Lowercase agents content" in content


async def test_uppercase_over_lowercase(temp_work_dir: KaosPath):
    """AGENTS.md and agents.md are mutually exclusive; uppercase wins.

    On case-insensitive filesystems (macOS) both names resolve to the same
    file, so we only verify one entry per directory.
    """
    await (temp_work_dir / "AGENTS.md").write_text("uppercase")

    content = await load_agents_md(temp_work_dir)

    assert content is not None
    assert "uppercase" in content
    assert content.count("<!-- From:") == 1


# ---------------------------------------------------------------------------
# .kimi/ directory
# ---------------------------------------------------------------------------


async def test_kimi_dir_and_root_both_loaded(temp_work_dir: KaosPath):
    """.kimi/AGENTS.md and AGENTS.md in the same dir are both loaded; .kimi/ first."""
    kimi_dir = temp_work_dir / ".kimi"
    await kimi_dir.mkdir()
    await (kimi_dir / "AGENTS.md").write_text("kimi agents")
    await (temp_work_dir / "AGENTS.md").write_text("root agents")

    content = await load_agents_md(temp_work_dir)

    assert content is not None
    assert content.index("kimi agents") < content.index("root agents")
    assert content.count("<!-- From:") == 2


async def test_kimi_dir_in_parent(temp_work_dir: KaosPath):
    """.kimi/AGENTS.md in a parent directory is discovered via hierarchy."""
    await (temp_work_dir / ".git").mkdir()
    kimi_dir = temp_work_dir / ".kimi"
    await kimi_dir.mkdir()
    await (kimi_dir / "AGENTS.md").write_text("parent kimi")

    child = temp_work_dir / "pkg"
    await child.mkdir()
    await (child / "AGENTS.md").write_text("child root")

    content = await load_agents_md(child)

    assert content is not None
    assert "parent kimi" in content
    assert "child root" in content
    assert content.index("parent kimi") < content.index("child root")


# ---------------------------------------------------------------------------
# Hierarchical loading (project root → work_dir)
# ---------------------------------------------------------------------------


async def test_hierarchical_three_levels(temp_work_dir: KaosPath):
    """Three-level hierarchy: root → mid → leaf, merged in order."""
    await (temp_work_dir / ".git").mkdir()
    await (temp_work_dir / "AGENTS.md").write_text("L0")

    mid = temp_work_dir / "src"
    await mid.mkdir()
    await (mid / "AGENTS.md").write_text("L1")

    leaf = mid / "app"
    await leaf.mkdir()
    await (leaf / "AGENTS.md").write_text("L2")

    content = await load_agents_md(leaf)

    assert content is not None
    assert content.index("L0") < content.index("L1") < content.index("L2")
    assert content.count("<!-- From:") == 3


async def test_no_git_fallback(temp_work_dir: KaosPath):
    """Without .git, only work_dir itself is searched."""
    await (temp_work_dir / "AGENTS.md").write_text("root agents")

    sub = temp_work_dir / "src"
    await sub.mkdir()
    await (sub / "AGENTS.md").write_text("sub agents")

    content = await load_agents_md(sub)

    assert content is not None
    assert "sub agents" in content
    assert "root agents" not in content


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


async def test_empty_file_skipped(temp_work_dir: KaosPath):
    """Empty AGENTS.md is skipped; non-empty sibling still loaded."""
    await (temp_work_dir / ".git").mkdir()
    await (temp_work_dir / "AGENTS.md").write_text("")

    sub = temp_work_dir / "src"
    await sub.mkdir()
    await (sub / "AGENTS.md").write_text("real content")

    content = await load_agents_md(sub)

    assert content is not None
    assert "real content" in content
    assert content.count("<!-- From:") == 1


async def test_max_bytes_leaf_prioritised(temp_work_dir: KaosPath):
    """Budget is allocated leaf-first: deeper files are kept, shallower truncated."""
    await (temp_work_dir / ".git").mkdir()

    # Root file is large (nearly fills the budget)
    root_size = _AGENTS_MD_MAX_BYTES - 100
    await (temp_work_dir / "AGENTS.md").write_text("A" * root_size)

    # Leaf file is small but more specific
    sub = temp_work_dir / "pkg"
    await sub.mkdir()
    await (sub / "AGENTS.md").write_text("B" * 1000)

    content = await load_agents_md(sub)

    assert content is not None
    # Leaf file (B) should be fully preserved
    assert content.count("B") == 1000
    # Root file (A) should be truncated to fit the remaining budget
    assert content.count("A") < root_size
    # Total output (including annotations) must not exceed the limit
    assert len(content.encode()) <= _AGENTS_MD_MAX_BYTES

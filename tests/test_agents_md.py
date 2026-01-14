from pathlib import Path

import pytest
from inline_snapshot import snapshot
from kaos.path import KaosPath

from kimi_cli.soul.agent import load_agents_md


@pytest.mark.asyncio
async def test_load_agents_md_merges_global_and_project(monkeypatch, tmp_path):
    home_dir = tmp_path / "home"
    global_dir = home_dir / ".config" / "agents"
    global_dir.mkdir(parents=True)
    (global_dir / "AGENTS.md").write_text("Global", encoding="utf-8")
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    project_dir = tmp_path / "project"
    project_dir.mkdir()
    (project_dir / "AGENTS.md").write_text("Project", encoding="utf-8")

    agents_md = await load_agents_md(KaosPath.unsafe_from_local_path(project_dir))

    assert agents_md == snapshot("Global\n\nProject")


@pytest.mark.asyncio
async def test_load_agents_md_uses_lowercase_fallback(monkeypatch, tmp_path):
    home_dir = tmp_path / "home"
    home_dir.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    project_dir = tmp_path / "project"
    project_dir.mkdir()
    (project_dir / "agents.md").write_text("Lowercase", encoding="utf-8")

    agents_md = await load_agents_md(KaosPath.unsafe_from_local_path(project_dir))

    assert agents_md == snapshot("Lowercase")


@pytest.mark.asyncio
async def test_load_agents_md_supports_global_only(monkeypatch, tmp_path):
    home_dir = tmp_path / "home"
    global_dir = home_dir / ".config" / "agents"
    global_dir.mkdir(parents=True)
    (global_dir / "AGENTS.md").write_text("Global only", encoding="utf-8")
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    project_dir = tmp_path / "project"
    project_dir.mkdir()

    agents_md = await load_agents_md(KaosPath.unsafe_from_local_path(project_dir))

    assert agents_md == snapshot("Global only")

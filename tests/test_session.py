from pathlib import Path

import pytest

from kimi_cli.metadata import load_metadata
from kimi_cli.session import Session


@pytest.fixture
def isolated_share_dir(monkeypatch, tmp_path: Path) -> Path:
    """Provide an isolated share directory for metadata operations."""

    share_dir = tmp_path / "share"
    share_dir.mkdir()

    def _get_share_dir() -> Path:
        share_dir.mkdir(parents=True, exist_ok=True)
        return share_dir

    monkeypatch.setattr("kimi_cli.share.get_share_dir", _get_share_dir)
    monkeypatch.setattr("kimi_cli.metadata.get_share_dir", _get_share_dir)
    return share_dir


def test_session_last_id_updates_on_mark(tmp_path: Path, isolated_share_dir: Path):
    work_dir = tmp_path / "project"
    work_dir.mkdir()

    session = Session.create(work_dir)
    metadata = load_metadata()
    assert metadata.work_dirs[0].last_session_id is None

    session.mark_as_last()
    metadata = load_metadata()
    assert metadata.work_dirs[0].last_session_id == session.id


def test_session_continue_uses_last_completed_session(tmp_path: Path, isolated_share_dir: Path):
    work_dir = tmp_path / "project"
    work_dir.mkdir()

    session1 = Session.create(work_dir)
    session1.mark_as_last()
    session2 = Session.create(work_dir)

    resumed = Session.continue_(work_dir)
    assert resumed is not None
    assert resumed.id == session1.id

    session2.mark_as_last()
    resumed = Session.continue_(work_dir)
    assert resumed is not None
    assert resumed.id == session2.id

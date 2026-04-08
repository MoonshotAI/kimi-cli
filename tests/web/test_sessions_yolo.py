"""Tests for sessions YOLO mode API endpoints."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from kimi_cli.session_state import ApprovalStateData, SessionState, save_session_state
from kimi_cli.web.app import create_app
from kimi_cli.web.runner.process import KimiCLIRunner, SessionProcess
from kimi_cli.wire.file import WireFile
from kimi_cli.wire.types import StatusUpdate


def create_mock_runner() -> KimiCLIRunner:
    """Create a mock KimiCLIRunner with no running sessions."""
    mock_runner = MagicMock(spec=KimiCLIRunner)
    mock_runner.get_session.return_value = None
    return mock_runner


def create_mock_runner_with_running_session() -> KimiCLIRunner:
    """Create a mock KimiCLIRunner with a running session."""
    mock_runner = MagicMock(spec=KimiCLIRunner)
    mock_process = MagicMock(spec=SessionProcess)
    mock_process.is_alive = True
    mock_process.set_yolo_mode = AsyncMock()
    mock_runner.get_session.return_value = mock_process
    return mock_runner


def create_test_session(share_dir: Path) -> tuple[UUID, Path]:
    """Create a test session with a temporary directory."""
    from kimi_cli.metadata import Metadata, WorkDirMeta, save_metadata

    session_id = uuid4()
    work_dir = share_dir / "work"
    work_dir.mkdir()

    metadata = Metadata(work_dirs=[WorkDirMeta(path=str(work_dir))])
    save_metadata(metadata)

    session_dir = metadata.work_dirs[0].sessions_dir / str(session_id)
    session_dir.mkdir(parents=True)

    # Create a minimal context.jsonl file
    (session_dir / "context.jsonl").write_text("{}", encoding="utf-8")

    return session_id, session_dir


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    """Create a test client with isolated metadata and mock runner."""
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
    app = create_app()
    app.state.runner = create_mock_runner()
    return TestClient(app)


class TestGetYoloStatus:
    """Tests for GET /api/sessions/{session_id}/yolo endpoint."""

    def test_get_yolo_status_session_not_found(self, client: TestClient) -> None:
        """Test 404 response when session does not exist."""
        response = client.get(f"/api/sessions/{uuid4()}/yolo")

        assert response.status_code == 404
        assert response.json()["detail"] == "Session not found"

    def test_get_yolo_status_default_false(self, client: TestClient, tmp_path: Path) -> None:
        """Test that default YOLO status is false."""
        session_id, _ = create_test_session(tmp_path)

        response = client.get(f"/api/sessions/{session_id}/yolo")

        assert response.status_code == 200
        data = response.json()
        assert data["enabled"] is False
        assert data["auto_approve_actions"] == []

    def test_get_yolo_status_enabled(self, client: TestClient, tmp_path: Path) -> None:
        """Test getting YOLO status when enabled."""
        session_id, session_dir = create_test_session(tmp_path)

        # Set YOLO mode to enabled in session state
        state = SessionState(
            approval=ApprovalStateData(
                yolo=True,
                auto_approve_actions={"Shell", "WriteFile"},
            ),
        )
        save_session_state(state, session_dir)

        response = client.get(f"/api/sessions/{session_id}/yolo")

        assert response.status_code == 200
        data = response.json()
        assert data["enabled"] is True
        assert set(data["auto_approve_actions"]) == {"Shell", "WriteFile"}


class TestUpdateYoloStatus:
    """Tests for POST /api/sessions/{session_id}/yolo endpoint."""

    def test_update_yolo_status_session_not_found(self, client: TestClient) -> None:
        """Test 404 response when session does not exist."""
        response = client.post(
            f"/api/sessions/{uuid4()}/yolo",
            json={"enabled": True},
        )

        assert response.status_code == 404
        assert response.json()["detail"] == "Session not found"

    def test_update_yolo_status_enable_stopped_session(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """Test enabling YOLO mode for a stopped session."""
        session_id, session_dir = create_test_session(tmp_path)

        response = client.post(
            f"/api/sessions/{session_id}/yolo",
            json={"enabled": True},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["enabled"] is True

        # Verify session state was saved
        state_file = session_dir / "state.json"
        assert state_file.exists()
        state_data = json.loads(state_file.read_text(encoding="utf-8"))
        assert state_data["approval"]["yolo"] is True

    def test_update_yolo_status_disable_stopped_session(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """Test disabling YOLO mode for a stopped session."""
        session_id, session_dir = create_test_session(tmp_path)

        # First enable YOLO
        client.post(f"/api/sessions/{session_id}/yolo", json={"enabled": True})

        # Then disable it
        response = client.post(
            f"/api/sessions/{session_id}/yolo",
            json={"enabled": False},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["enabled"] is False

        # Verify session state was saved
        state_file = session_dir / "state.json"
        state_data = json.loads(state_file.read_text(encoding="utf-8"))
        assert state_data["approval"]["yolo"] is False

    def test_update_yolo_status_preserves_auto_approve_actions(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """Test that updating YOLO mode preserves auto_approve_actions."""
        session_id, session_dir = create_test_session(tmp_path)

        # Set initial state with auto_approve_actions
        state = SessionState(
            approval=ApprovalStateData(
                yolo=False,
                auto_approve_actions={"Shell", "WriteFile"},
            ),
        )
        save_session_state(state, session_dir)

        response = client.post(
            f"/api/sessions/{session_id}/yolo",
            json={"enabled": True},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["enabled"] is True
        assert set(data["auto_approve_actions"]) == {"Shell", "WriteFile"}

    @pytest.mark.anyio
    async def test_update_yolo_status_persists_to_wire_jsonl(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        """Test that updating YOLO mode for stopped session persists to wire.jsonl."""
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
        session_id, session_dir = create_test_session(tmp_path)

        app = create_app()
        app.state.runner = create_mock_runner()

        with TestClient(app) as client:
            response = client.post(
                f"/api/sessions/{session_id}/yolo",
                json={"enabled": True},
            )

        assert response.status_code == 200

        # Verify wire.jsonl was created with StatusUpdate
        wire_file = WireFile(session_dir / "wire.jsonl")
        assert wire_file.path.exists()

        # Read and verify the wire file contents
        records = []
        async for record in wire_file.iter_records():
            records.append(record)

        assert len(records) == 1
        msg = records[0].to_wire_message()
        assert isinstance(msg, StatusUpdate)
        assert msg.yolo_mode is True

    @pytest.mark.anyio
    async def test_update_yolo_status_disable_persists_to_wire_jsonl(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        """Test that disabling YOLO mode for stopped session persists to wire.jsonl."""
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
        session_id, session_dir = create_test_session(tmp_path)

        app = create_app()
        app.state.runner = create_mock_runner()

        with TestClient(app) as client:
            # First enable, then disable
            client.post(f"/api/sessions/{session_id}/yolo", json={"enabled": True})
            response = client.post(
                f"/api/sessions/{session_id}/yolo",
                json={"enabled": False},
            )

        assert response.status_code == 200

        # Verify wire.jsonl contains both status updates
        wire_file = WireFile(session_dir / "wire.jsonl")
        records = []
        async for record in wire_file.iter_records():
            records.append(record)

        assert len(records) == 2
        # Check the second update (disable)
        msg = records[1].to_wire_message()
        assert isinstance(msg, StatusUpdate)
        assert msg.yolo_mode is False


class TestUpdateYoloStatusRunningSession:
    """Tests for updating YOLO status on running sessions."""

    @pytest.mark.anyio
    async def test_update_yolo_status_running_session_calls_set_yolo_mode(
        self,
        tmp_path: Path,
        monkeypatch,
    ) -> None:
        """Test that updating YOLO on running session notifies the worker."""
        from kimi_cli.web.api.sessions import update_yolo_status
        from kimi_cli.web.models import UpdateYoloRequest

        session_id, _ = create_test_session(tmp_path)

        # Create mock runner with running session
        mock_runner = create_mock_runner_with_running_session()

        result = await update_yolo_status(
            session_id=session_id,
            request=UpdateYoloRequest(enabled=True),
            runner=mock_runner,
        )

        assert result.enabled is True

        # Verify set_yolo_mode was called on the running session
        mock_process = mock_runner.get_session.return_value
        mock_process.set_yolo_mode.assert_awaited_once_with(True)

    @pytest.mark.anyio
    async def test_update_yolo_status_running_session_does_not_save_to_disk(
        self,
        tmp_path: Path,
        monkeypatch,
    ) -> None:
        """Test that updating YOLO on running session does not save to disk directly."""
        from kimi_cli.web.api.sessions import update_yolo_status
        from kimi_cli.web.models import UpdateYoloRequest

        session_id, session_dir = create_test_session(tmp_path)

        # Create mock runner with running session
        mock_runner = create_mock_runner_with_running_session()

        await update_yolo_status(
            session_id=session_id,
            request=UpdateYoloRequest(enabled=True),
            runner=mock_runner,
        )

        # Verify state.json was NOT created (worker handles persistence)
        state_file = session_dir / "state.json"
        assert not state_file.exists()

        # Verify wire.jsonl was NOT created
        wire_file = session_dir / "wire.jsonl"
        assert not wire_file.exists()


class TestYoloStatusRoundTrip:
    """Tests for round-trip YOLO status operations."""

    def test_yolo_status_round_trip(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """Test that YOLO status can be set and retrieved correctly."""
        session_id, _ = create_test_session(tmp_path)

        # Initially false
        response = client.get(f"/api/sessions/{session_id}/yolo")
        assert response.json()["enabled"] is False

        # Enable YOLO
        response = client.post(f"/api/sessions/{session_id}/yolo", json={"enabled": True})
        assert response.json()["enabled"] is True

        # Verify it's now enabled
        response = client.get(f"/api/sessions/{session_id}/yolo")
        assert response.json()["enabled"] is True

        # Disable YOLO
        response = client.post(f"/api/sessions/{session_id}/yolo", json={"enabled": False})
        assert response.json()["enabled"] is False

        # Verify it's now disabled
        response = client.get(f"/api/sessions/{session_id}/yolo")
        assert response.json()["enabled"] is False


class TestYoloStatusWireReplay:
    """Tests for YOLO status replay from wire.jsonl."""

    @pytest.mark.anyio
    async def test_wire_replay_includes_yolo_updates(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        """Test that wire.jsonl contains YOLO updates for replay."""
        monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path))
        session_id, session_dir = create_test_session(tmp_path)

        app = create_app()
        app.state.runner = create_mock_runner()

        with TestClient(app) as client:
            # Enable YOLO
            client.post(f"/api/sessions/{session_id}/yolo", json={"enabled": True})
            # Disable YOLO
            client.post(f"/api/sessions/{session_id}/yolo", json={"enabled": False})
            # Enable again
            client.post(f"/api/sessions/{session_id}/yolo", json={"enabled": True})

        # Verify wire.jsonl contains all three status updates
        wire_file = WireFile(session_dir / "wire.jsonl")
        records = []
        async for record in wire_file.iter_records():
            records.append(record)

        assert len(records) == 3

        # Check sequence: True, False, True
        msgs = [r.to_wire_message() for r in records]
        assert all(isinstance(m, StatusUpdate) for m in msgs)
        assert msgs[0].yolo_mode is True
        assert msgs[1].yolo_mode is False
        assert msgs[2].yolo_mode is True

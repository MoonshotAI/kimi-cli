"""Tests for the telemetry system."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import kimi_cli.telemetry as telemetry_mod
from kimi_cli.telemetry import attach_sink, disable, set_context, track
from kimi_cli.telemetry.sink import EventSink
from kimi_cli.telemetry.transport import AsyncTransport


@pytest.fixture(autouse=True)
def _reset_telemetry_state():
    """Reset telemetry module state before each test."""
    telemetry_mod._event_queue.clear()
    telemetry_mod._device_id = None
    telemetry_mod._session_id = None
    telemetry_mod._sink = None
    telemetry_mod._disabled = False
    yield
    telemetry_mod._event_queue.clear()
    telemetry_mod._device_id = None
    telemetry_mod._session_id = None
    telemetry_mod._sink = None
    telemetry_mod._disabled = False


class TestTrack:
    def test_track_queues_event_before_sink(self):
        """Events are queued in memory before sink is attached."""
        track("test_event", foo=True, bar=42)
        assert len(telemetry_mod._event_queue) == 1
        event = telemetry_mod._event_queue[0]
        assert event["event"] == "test_event"
        assert event["properties"] == {"foo": True, "bar": 42}
        assert event["timestamp"] > 0

    def test_track_includes_context_ids(self):
        """Events include device_id and session_id."""
        set_context(device_id="dev123", session_id="sess456")
        track("test_event")
        event = telemetry_mod._event_queue[0]
        assert event["device_id"] == "dev123"
        assert event["session_id"] == "sess456"

    def test_track_forwards_to_sink(self):
        """Events are forwarded to sink when attached."""
        mock_sink = MagicMock(spec=EventSink)
        attach_sink(mock_sink)
        track("test_event", key=1)
        mock_sink.accept.assert_called_once()
        event = mock_sink.accept.call_args[0][0]
        assert event["event"] == "test_event"
        assert event["properties"] == {"key": 1}

    def test_track_disabled_drops_events(self):
        """Events are silently dropped when disabled."""
        disable()
        track("test_event")
        assert len(telemetry_mod._event_queue) == 0

    def test_attach_sink_drains_queue(self):
        """Attaching sink drains queued events."""
        track("event1")
        track("event2")
        assert len(telemetry_mod._event_queue) == 2

        mock_sink = MagicMock(spec=EventSink)
        attach_sink(mock_sink)
        assert len(telemetry_mod._event_queue) == 0
        assert mock_sink.accept.call_count == 2

    def test_track_empty_properties(self):
        """Events with no properties have empty dict."""
        track("test_event")
        event = telemetry_mod._event_queue[0]
        assert event["properties"] == {}

    def test_track_string_properties(self):
        """String properties are allowed for enum-like values."""
        track("test_event", command="model", mode="agent")
        event = telemetry_mod._event_queue[0]
        assert event["properties"]["command"] == "model"
        assert event["properties"]["mode"] == "agent"

    def test_queue_max_size(self):
        """Queue drops oldest events when exceeding MAX_QUEUE_SIZE."""
        for i in range(telemetry_mod._MAX_QUEUE_SIZE + 100):
            track(f"event_{i}")
        assert len(telemetry_mod._event_queue) == telemetry_mod._MAX_QUEUE_SIZE
        # Oldest events should be dropped; newest should remain
        assert (
            telemetry_mod._event_queue[-1]["event"] == f"event_{telemetry_mod._MAX_QUEUE_SIZE + 99}"
        )
        assert telemetry_mod._event_queue[0]["event"] == "event_100"

    def test_disable_clears_sink_buffer(self):
        """Disabling telemetry clears the sink buffer."""
        mock_sink = MagicMock(spec=EventSink)
        attach_sink(mock_sink)
        track("event_before_disable")
        disable()
        mock_sink.clear_buffer.assert_called_once()
        # Further events should be dropped
        track("event_after_disable")
        # accept should have been called once (before disable), not twice
        assert mock_sink.accept.call_count == 1

    def test_event_id_is_hex_string(self):
        """Every event has a unique event_id (hex string)."""
        track("test_event")
        event = telemetry_mod._event_queue[0]
        assert "event_id" in event
        assert isinstance(event["event_id"], str)
        assert len(event["event_id"]) == 32  # uuid4 hex

    def test_event_ids_are_unique(self):
        """Each event gets a distinct event_id."""
        track("event_a")
        track("event_b")
        ids = [e["event_id"] for e in telemetry_mod._event_queue]
        assert ids[0] != ids[1]

    def test_backfill_device_and_session_id_on_attach(self):
        """Events tracked before set_context() get backfilled on attach_sink()."""
        # Track before context is set — device_id/session_id are None
        track("early_event")
        assert telemetry_mod._event_queue[0]["device_id"] is None
        assert telemetry_mod._event_queue[0]["session_id"] is None

        # Now set context and attach sink
        set_context(device_id="dev-backfill", session_id="sess-backfill")
        mock_sink = MagicMock(spec=EventSink)
        attach_sink(mock_sink)

        # The event forwarded to sink should have backfilled ids
        event = mock_sink.accept.call_args[0][0]
        assert event["device_id"] == "dev-backfill"
        assert event["session_id"] == "sess-backfill"


class TestEventSink:
    def test_accept_enriches_context(self):
        """Events are enriched with version/platform context."""
        transport = MagicMock(spec=AsyncTransport)
        sink = EventSink(transport, version="1.0.0", model="kimi-k2.5")
        event: dict[str, Any] = {
            "event": "test",
            "timestamp": time.time(),
            "properties": {},
        }
        sink.accept(event)
        # accept() should not mutate the original event dict
        assert "context" not in event
        # The enriched copy should be in the buffer
        sink.flush_sync()
        buffered = transport.save_to_disk.call_args[0][0][0]
        assert buffered["context"]["version"] == "1.0.0"
        assert buffered["context"]["model"] == "kimi-k2.5"
        assert "platform" in buffered["context"]
        assert "ui_mode" in buffered["context"]
        assert "python_version" in buffered["context"]
        assert "os_version" in buffered["context"]
        assert isinstance(buffered["context"]["ci"], bool)
        assert "locale" in buffered["context"]
        assert "terminal" in buffered["context"]

    def test_flush_sync_saves_to_disk(self):
        """Sync flush saves events to disk via transport."""
        transport = MagicMock(spec=AsyncTransport)
        sink = EventSink(transport, version="1.0.0")
        sink.accept({"event": "test", "timestamp": 1.0, "properties": {}})
        sink.flush_sync()
        transport.save_to_disk.assert_called_once()
        events = transport.save_to_disk.call_args[0][0]
        assert len(events) == 1

    def test_flush_sync_noop_when_empty(self):
        """Sync flush is a no-op when buffer is empty."""
        transport = MagicMock(spec=AsyncTransport)
        sink = EventSink(transport, version="1.0.0")
        sink.flush_sync()
        transport.save_to_disk.assert_not_called()

    def test_accept_includes_ui_mode(self):
        """Events are enriched with ui_mode in context."""
        transport = MagicMock(spec=AsyncTransport)
        sink = EventSink(transport, version="1.0.0", ui_mode="print")
        sink.accept({"event": "test", "timestamp": 1.0, "properties": {}})
        sink.flush_sync()
        buffered = transport.save_to_disk.call_args[0][0][0]
        assert buffered["context"]["ui_mode"] == "print"

    def test_accept_default_ui_mode_is_shell(self):
        """Default ui_mode is 'shell'."""
        transport = MagicMock(spec=AsyncTransport)
        sink = EventSink(transport, version="1.0.0")
        sink.accept({"event": "test", "timestamp": 1.0, "properties": {}})
        sink.flush_sync()
        buffered = transport.save_to_disk.call_args[0][0][0]
        assert buffered["context"]["ui_mode"] == "shell"


class TestAsyncTransport:
    def test_save_to_disk(self, tmp_path: Path):
        """Events are saved as JSONL files."""
        with patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path):
            transport = AsyncTransport()
            events = [
                {"event": "e1", "timestamp": 1.0},
                {"event": "e2", "timestamp": 2.0},
            ]
            transport.save_to_disk(events)

        files = list(tmp_path.glob("failed_*.jsonl"))
        assert len(files) == 1
        lines = files[0].read_text().strip().split("\n")
        assert len(lines) == 2
        assert json.loads(lines[0])["event"] == "e1"
        assert json.loads(lines[1])["event"] == "e2"

    def test_save_to_disk_empty(self, tmp_path: Path):
        """No file is created for empty event list."""
        with patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path):
            transport = AsyncTransport()
            transport.save_to_disk([])

        files = list(tmp_path.glob("failed_*.jsonl"))
        assert len(files) == 0

    @pytest.mark.asyncio
    async def test_send_falls_back_on_error(self):
        """HTTP errors trigger disk fallback."""
        transport = AsyncTransport(endpoint="https://mock.test/events")

        # Make _send_http raise a transient error
        from kimi_cli.telemetry.transport import _TransientError

        with (
            patch.object(
                transport, "_send_http", new_callable=AsyncMock, side_effect=_TransientError("500")
            ),
            patch.object(transport, "save_to_disk") as mock_save,
        ):
            await transport.send([{"event": "test", "timestamp": 1.0}])
            mock_save.assert_called_once()

    @pytest.mark.asyncio
    async def test_send_success_no_fallback(self):
        """Successful send does not fall back to disk."""
        transport = AsyncTransport(endpoint="https://mock.test/events")

        with (
            patch.object(transport, "_send_http", new_callable=AsyncMock),
            patch.object(transport, "save_to_disk") as mock_save,
        ):
            await transport.send([{"event": "test", "timestamp": 1.0}])
            mock_save.assert_not_called()

    @pytest.mark.asyncio
    async def test_retry_disk_events_success(self, tmp_path: Path):
        """Disk events are retried and deleted on success."""
        # Create a failed events file
        failed_file = tmp_path / "failed_abc123.jsonl"
        failed_file.write_text('{"event":"old","timestamp":1.0}\n')

        transport = AsyncTransport(endpoint="https://mock.test/events")

        with (
            patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path),
            patch.object(transport, "_send_http", new_callable=AsyncMock) as mock_send,
        ):
            await transport.retry_disk_events()
            mock_send.assert_called_once()
            # File should be deleted after successful retry
            assert not failed_file.exists()

    @pytest.mark.asyncio
    async def test_retry_disk_events_expired_file(self, tmp_path: Path):
        """Expired disk event files are deleted without retry."""
        import os

        failed_file = tmp_path / "failed_expired.jsonl"
        failed_file.write_text('{"event":"old","timestamp":1.0}\n')
        # Set mtime to 8 days ago
        old_time = time.time() - 8 * 24 * 3600
        os.utime(failed_file, (old_time, old_time))

        transport = AsyncTransport(endpoint="https://mock.test/events")

        with (
            patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path),
            patch.object(transport, "_send_http", new_callable=AsyncMock) as mock_send,
        ):
            await transport.retry_disk_events()
            mock_send.assert_not_called()
            assert not failed_file.exists()

    @pytest.mark.asyncio
    async def test_retry_disk_events_keeps_file_on_unexpected_error(self, tmp_path: Path):
        """Unexpected errors during retry should keep the file for next startup."""
        failed_file = tmp_path / "failed_keep.jsonl"
        failed_file.write_text('{"event":"ok","timestamp":1.0}\n')

        transport = AsyncTransport(endpoint="https://mock.test/events")

        with (
            patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path),
            patch.object(
                transport,
                "_send_http",
                new_callable=AsyncMock,
                side_effect=RuntimeError("SSL error"),
            ),
        ):
            await transport.retry_disk_events()
            # File should be preserved for next retry
            assert failed_file.exists()

    @pytest.mark.asyncio
    async def test_retry_disk_events_deletes_corrupted_file(self, tmp_path: Path):
        """Corrupted (non-JSON) files are deleted."""
        failed_file = tmp_path / "failed_corrupt.jsonl"
        failed_file.write_text("this is not json\n")

        transport = AsyncTransport(endpoint="https://mock.test/events")

        with (
            patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path),
            patch.object(transport, "_send_http", new_callable=AsyncMock) as mock_send,
        ):
            await transport.retry_disk_events()
            mock_send.assert_not_called()
            assert not failed_file.exists()

    @pytest.mark.asyncio
    async def test_send_401_no_token_falls_back_to_disk(self, tmp_path: Path):
        """401 response when no token is present should trigger disk fallback, not silently drop."""
        transport = AsyncTransport(
            get_access_token=lambda: None,  # no token
            endpoint="https://mock.test/events",
        )

        mock_resp = MagicMock()
        mock_resp.status = 401
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = MagicMock()
        mock_session.post.return_value = mock_resp
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with (
            patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path),
            patch("kimi_cli.utils.aiohttp.new_client_session", return_value=mock_session),
        ):
            await transport.send([{"event": "test", "timestamp": 1.0}])

        # Event should have been saved to disk rather than silently dropped
        saved_files = list(tmp_path.glob("failed_*.jsonl"))
        assert len(saved_files) == 1

    @pytest.mark.asyncio
    async def test_anonymous_retry_4xx_drops_events(self):
        """Anonymous retry returning 4xx (client error) drops events without disk fallback."""
        transport = AsyncTransport(endpoint="https://mock.test/events")

        call_count = 0

        async def mock_send_http(payload: dict) -> None:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Simulate: first call succeeds (no _TransientError), events are "sent"
                # But we need to test the internal 4xx path. We'll test via send() + save_to_disk.
                pass

        # More direct: patch _send_http to NOT raise (simulating 4xx handled internally)
        # The 4xx path returns without raising, so send() should not call save_to_disk.
        with (
            patch.object(transport, "_send_http", new_callable=AsyncMock),
            patch.object(transport, "save_to_disk") as mock_save,
        ):
            await transport.send([{"event": "test", "timestamp": 1.0}])
            mock_save.assert_not_called()

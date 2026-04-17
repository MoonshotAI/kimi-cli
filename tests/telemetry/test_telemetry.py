"""Tests for the telemetry system."""

from __future__ import annotations

import asyncio
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
    telemetry_mod._client_info = None
    telemetry_mod._sink = None
    telemetry_mod._disabled = False
    yield
    telemetry_mod._event_queue.clear()
    telemetry_mod._device_id = None
    telemetry_mod._session_id = None
    telemetry_mod._client_info = None
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
        """HTTP errors trigger disk fallback after retries are exhausted."""
        transport = AsyncTransport(endpoint="https://mock.test/events", retry_backoffs_s=())

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

    def test_default_retry_schedule(self):
        """Lock down the production backoff schedule so it isn't silently changed."""
        from kimi_cli.telemetry.transport import RETRY_BACKOFFS_S

        assert RETRY_BACKOFFS_S == (1.0, 4.0, 16.0)

    def test_server_prefix_constant(self):
        """Lock down the production server prefix so it isn't silently changed."""
        from kimi_cli.telemetry.transport import SERVER_EVENT_PREFIX

        assert SERVER_EVENT_PREFIX == "kfc_"

    def test_apply_server_prefix_one_does_not_mutate_input(self):
        """_apply_server_prefix_one builds a new dict with prefix, input untouched."""
        from kimi_cli.telemetry.transport import _apply_server_prefix_one

        event = {"event": "started", "timestamp": 1.0, "properties": {"a": 1}}
        snapshot = dict(event)
        out = _apply_server_prefix_one(event)
        assert event == snapshot
        assert out["event"] == "kfc_started"
        # Shallow-shared sub-dicts are fine (not mutated downstream).
        assert out["properties"] is event["properties"]

    def test_apply_server_prefix_one_idempotent(self):
        """Events already carrying the prefix pass through unchanged (no copy)."""
        from kimi_cli.telemetry.transport import _apply_server_prefix_one

        event = {"event": "kfc_already", "timestamp": 2.0, "properties": {}}
        out = _apply_server_prefix_one(event)
        assert out is event
        assert out["event"] == "kfc_already"

    def test_apply_server_prefix_one_passthrough_edge_cases(self):
        """Missing / empty / non-string event values pass through unchanged."""
        from kimi_cli.telemetry.transport import _apply_server_prefix_one

        missing = {"timestamp": 1.0}
        empty = {"event": "", "timestamp": 2.0}
        non_str = {"event": 42, "timestamp": 3.0}

        assert _apply_server_prefix_one(missing) is missing
        assert _apply_server_prefix_one(empty) is empty
        assert _apply_server_prefix_one(non_str) is non_str

    @pytest.mark.asyncio
    async def test_send_adds_server_prefix_to_event_names(self):
        """Outbound payload carries kfc_ prefix and is flattened; in-memory events stay bare + nested."""
        transport = AsyncTransport(
            device_id="dev-xyz",
            endpoint="https://mock.test/events",
            retry_backoffs_s=(),
        )

        captured: dict[str, Any] = {}

        async def capture(payload: dict[str, Any]) -> None:
            captured.update(payload)

        events_in = [
            {"event": "started", "timestamp": 1.0, "properties": {}},
            {"event": "tool_call", "timestamp": 2.0, "properties": {"success": True}},
        ]
        with patch.object(transport, "_send_http", new=capture):
            await transport.send(events_in)

        # Payload-level user_id
        assert captured["user_id"] == "kfc_device_id_dev-xyz"

        outbound = captured["events"]
        assert [e["event"] for e in outbound] == ["kfc_started", "kfc_tool_call"]
        # Original events list untouched (save_to_disk would keep bare + nested shape)
        assert [e["event"] for e in events_in] == ["started", "tool_call"]
        assert events_in[1]["properties"] == {"success": True}
        # Properties flattened; timestamp preserved
        assert outbound[1]["property_success"] is True
        assert outbound[1]["timestamp"] == 2.0
        # Outbound events should not carry the nested sub-dicts anymore
        assert "properties" not in outbound[1]
        assert "context" not in outbound[1]

    @pytest.mark.asyncio
    async def test_send_is_idempotent_on_already_prefixed_events(self):
        """Events already carrying the prefix are not double-prefixed."""
        transport = AsyncTransport(endpoint="https://mock.test/events", retry_backoffs_s=())

        captured: dict[str, Any] = {}

        async def capture(payload: dict[str, Any]) -> None:
            captured.update(payload)

        events_in = [{"event": "kfc_legacy", "timestamp": 1.0, "properties": {}}]
        with patch.object(transport, "_send_http", new=capture):
            await transport.send(events_in)

        assert captured["events"][0]["event"] == "kfc_legacy"  # not "kfc_kfc_legacy"

    @pytest.mark.asyncio
    async def test_disk_fallback_keeps_bare_names(self):
        """Transient failure saves events to disk with the bare (unprefixed) name."""
        transport = AsyncTransport(endpoint="https://mock.test/events", retry_backoffs_s=())
        from kimi_cli.telemetry.transport import _TransientError

        events_in = [{"event": "exit", "timestamp": 1.0, "properties": {}}]
        with (
            patch.object(
                transport, "_send_http", new_callable=AsyncMock, side_effect=_TransientError("503")
            ),
            patch.object(transport, "save_to_disk") as mock_save,
        ):
            await transport.send(events_in)
            saved = mock_save.call_args[0][0]
            assert saved[0]["event"] == "exit"  # bare name for disk retry

    @pytest.mark.asyncio
    async def test_send_retries_transient_then_falls_back(self):
        """send() retries transient errors (without sleeping) then falls back to disk."""
        transport = AsyncTransport(
            endpoint="https://mock.test/events",
            # 3 attempts total: initial + 2 retries (zero sleep for test speed)
            retry_backoffs_s=(0.0, 0.0),
        )
        from kimi_cli.telemetry.transport import _TransientError

        send_mock = AsyncMock(side_effect=_TransientError("503"))
        with (
            patch.object(transport, "_send_http", send_mock),
            patch.object(transport, "save_to_disk") as mock_save,
        ):
            await transport.send([{"event": "test", "timestamp": 1.0}])
            assert send_mock.await_count == 3
            mock_save.assert_called_once()

    @pytest.mark.asyncio
    async def test_send_retry_succeeds_no_fallback(self):
        """send() retries transient errors and succeeds without hitting disk."""
        transport = AsyncTransport(
            endpoint="https://mock.test/events",
            retry_backoffs_s=(0.0, 0.0),
        )
        from kimi_cli.telemetry.transport import _TransientError

        # Fail once, succeed on second attempt
        send_mock = AsyncMock(side_effect=[_TransientError("503"), None])
        with (
            patch.object(transport, "_send_http", send_mock),
            patch.object(transport, "save_to_disk") as mock_save,
        ):
            await transport.send([{"event": "test", "timestamp": 1.0}])
            assert send_mock.await_count == 2
            mock_save.assert_not_called()

    @pytest.mark.asyncio
    async def test_send_cancelled_during_backoff_saves_to_disk(self):
        """If the send task is cancelled mid-backoff, events must be persisted."""
        transport = AsyncTransport(
            endpoint="https://mock.test/events",
            # Non-zero backoff so there's a real sleep point to cancel
            retry_backoffs_s=(60.0,),
        )
        from kimi_cli.telemetry.transport import _TransientError

        # _send_http always raises _TransientError; first attempt fails,
        # then asyncio.sleep(60) gives us a window to cancel the task.
        send_mock = AsyncMock(side_effect=_TransientError("503"))

        with (
            patch.object(transport, "_send_http", send_mock),
            patch.object(transport, "save_to_disk") as mock_save,
        ):
            task = asyncio.create_task(transport.send([{"event": "test", "timestamp": 1.0}]))
            # Let the first attempt fail and enter the backoff sleep
            await asyncio.sleep(0.05)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

            # Events must have been persisted to disk before the cancel propagated
            mock_save.assert_called_once()
            saved_events = mock_save.call_args[0][0]
            assert len(saved_events) == 1
            assert saved_events[0]["event"] == "test"

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
        """Disk events are retried through the outbound pipeline, file deleted."""
        # Mix of bare names (new format) and already-prefixed (legacy format).
        failed_file = tmp_path / "failed_abc123.jsonl"
        failed_file.write_text(
            '{"event":"old","timestamp":1.0}\n{"event":"kfc_legacy","timestamp":2.0}\n'
        )

        transport = AsyncTransport(device_id="dev-retry", endpoint="https://mock.test/events")

        with (
            patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path),
            patch.object(transport, "_send_http", new_callable=AsyncMock) as mock_send,
        ):
            await transport.retry_disk_events()
            mock_send.assert_called_once()
            payload = mock_send.call_args[0][0]
            # Same outbound pipeline: user_id at top + prefixed, flat events
            assert payload["user_id"] == "kfc_device_id_dev-retry"
            assert [e["event"] for e in payload["events"]] == ["kfc_old", "kfc_legacy"]
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
            retry_backoffs_s=(),
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
        """401 with token → anonymous retry returns 4xx → events dropped, no disk fallback."""
        transport = AsyncTransport(
            get_access_token=lambda: "valid-token",
            endpoint="https://mock.test/events",
        )

        # First response: 401 (triggers anonymous retry)
        resp_401 = MagicMock()
        resp_401.status = 401
        resp_401.__aenter__ = AsyncMock(return_value=resp_401)
        resp_401.__aexit__ = AsyncMock(return_value=False)

        # Second response: 403 (client error on anonymous retry)
        resp_403 = MagicMock()
        resp_403.status = 403
        resp_403.__aenter__ = AsyncMock(return_value=resp_403)
        resp_403.__aexit__ = AsyncMock(return_value=False)

        mock_session = MagicMock()
        mock_session.post = MagicMock(side_effect=[resp_401, resp_403])
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with (
            patch("kimi_cli.utils.aiohttp.new_client_session", return_value=mock_session),
            patch.object(transport, "save_to_disk") as mock_save,
        ):
            await transport.send([{"event": "test", "timestamp": 1.0}])
            mock_save.assert_not_called()

    @pytest.mark.asyncio
    async def test_401_with_token_anonymous_retry_success(self):
        """401 with token → anonymous retry returns 200 → success, no disk fallback."""
        transport = AsyncTransport(
            get_access_token=lambda: "valid-token",
            endpoint="https://mock.test/events",
        )

        resp_401 = MagicMock()
        resp_401.status = 401
        resp_401.__aenter__ = AsyncMock(return_value=resp_401)
        resp_401.__aexit__ = AsyncMock(return_value=False)

        resp_200 = MagicMock()
        resp_200.status = 200
        resp_200.__aenter__ = AsyncMock(return_value=resp_200)
        resp_200.__aexit__ = AsyncMock(return_value=False)

        mock_session = MagicMock()
        mock_session.post = MagicMock(side_effect=[resp_401, resp_200])
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with (
            patch("kimi_cli.utils.aiohttp.new_client_session", return_value=mock_session),
            patch.object(transport, "save_to_disk") as mock_save,
        ):
            await transport.send([{"event": "test", "timestamp": 1.0}])
            mock_save.assert_not_called()

    @pytest.mark.asyncio
    async def test_401_with_token_anonymous_retry_5xx(self, tmp_path: Path):
        """401 with token → anonymous retry returns 500 → disk fallback."""
        transport = AsyncTransport(
            get_access_token=lambda: "valid-token",
            endpoint="https://mock.test/events",
            retry_backoffs_s=(),
        )

        resp_401 = MagicMock()
        resp_401.status = 401
        resp_401.__aenter__ = AsyncMock(return_value=resp_401)
        resp_401.__aexit__ = AsyncMock(return_value=False)

        resp_500 = MagicMock()
        resp_500.status = 500
        resp_500.__aenter__ = AsyncMock(return_value=resp_500)
        resp_500.__aexit__ = AsyncMock(return_value=False)

        mock_session = MagicMock()
        mock_session.post = MagicMock(side_effect=[resp_401, resp_500])
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with (
            patch("kimi_cli.utils.aiohttp.new_client_session", return_value=mock_session),
            patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path),
        ):
            await transport.send([{"event": "test", "timestamp": 1.0}])

        saved_files = list(tmp_path.glob("failed_*.jsonl"))
        assert len(saved_files) == 1

    @pytest.mark.asyncio
    async def test_send_unexpected_exception_falls_back_to_disk(self, tmp_path: Path):
        """Unexpected exception during send triggers disk fallback."""
        transport = AsyncTransport(endpoint="https://mock.test/events")

        with (
            patch.object(
                transport,
                "_send_http",
                new_callable=AsyncMock,
                side_effect=RuntimeError("unexpected"),
            ),
            patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path),
        ):
            await transport.send([{"event": "test", "timestamp": 1.0}])

        saved_files = list(tmp_path.glob("failed_*.jsonl"))
        assert len(saved_files) == 1


class TestPayloadAssembly:
    """Unit tests for the outbound payload pipeline:
    _build_user_id / _flatten_event / _build_payload."""

    def test_user_id_prefix_constant(self):
        """Lock down the production user_id prefix so it isn't silently changed."""
        from kimi_cli.telemetry.transport import USER_ID_PREFIX

        assert USER_ID_PREFIX == "kfc_device_id_"

    def test_build_user_id(self):
        from kimi_cli.telemetry.transport import _build_user_id

        assert _build_user_id("abc123") == "kfc_device_id_abc123"

    def test_build_user_id_empty_device_id(self):
        """Empty device_id still returns the prefix (no crash)."""
        from kimi_cli.telemetry.transport import _build_user_id

        assert _build_user_id("") == "kfc_device_id_"

    def test_flatten_event_properties_prefix(self):
        from kimi_cli.telemetry.transport import _flatten_event

        out = _flatten_event(
            {
                "event": "tool_call",
                "timestamp": 1.0,
                "properties": {"tool_name": "bash", "approved": True},
            }
        )
        assert out["property_tool_name"] == "bash"
        assert out["property_approved"] is True
        assert "properties" not in out

    def test_flatten_event_context_prefix(self):
        from kimi_cli.telemetry.transport import _flatten_event

        out = _flatten_event(
            {
                "event": "tool_call",
                "timestamp": 1.0,
                "context": {"version": "1.0", "platform": "darwin", "ci": False},
            }
        )
        assert out["context_version"] == "1.0"
        assert out["context_platform"] == "darwin"
        assert out["context_ci"] is False
        assert "context" not in out

    def test_flatten_event_preserves_top_level(self):
        """event_id / event / timestamp / device_id / session_id pass through."""
        from kimi_cli.telemetry.transport import _flatten_event

        event = {
            "event_id": "eid",
            "event": "started",
            "timestamp": 1.5,
            "device_id": "d",
            "session_id": "s",
            "properties": {},
            "context": {},
        }
        out = _flatten_event(event)
        assert out["event_id"] == "eid"
        assert out["event"] == "started"
        assert out["timestamp"] == 1.5
        assert out["device_id"] == "d"
        assert out["session_id"] == "s"

    def test_flatten_event_does_not_mutate_input(self):
        from kimi_cli.telemetry.transport import _flatten_event

        event = {
            "event": "tool_call",
            "timestamp": 1.0,
            "properties": {"a": 1},
            "context": {"v": "x"},
        }
        snapshot = {
            "event": "tool_call",
            "timestamp": 1.0,
            "properties": {"a": 1},
            "context": {"v": "x"},
        }
        _flatten_event(event)
        assert event == snapshot

    def test_flatten_event_allows_none_values(self):
        from kimi_cli.telemetry.transport import _flatten_event

        out = _flatten_event({"event": "x", "timestamp": 1.0, "properties": {"reason": None}})
        assert out["property_reason"] is None

    def test_flatten_event_empty_properties_and_context(self):
        """Empty or missing sub-dicts produce no property_/context_ keys."""
        from kimi_cli.telemetry.transport import _flatten_event

        out = _flatten_event({"event": "x", "timestamp": 1.0, "properties": {}, "context": {}})
        assert all(not k.startswith("property_") for k in out)
        assert all(not k.startswith("context_") for k in out)

        # Missing entirely
        out2 = _flatten_event({"event": "x", "timestamp": 1.0})
        assert all(not k.startswith("property_") for k in out2)
        assert all(not k.startswith("context_") for k in out2)

    def test_flatten_event_raises_on_nested_dict_in_properties(self):
        from kimi_cli.telemetry.transport import _flatten_event

        with pytest.raises(TypeError, match="property.nested"):
            _flatten_event(
                {
                    "event": "x",
                    "timestamp": 1.0,
                    "properties": {"nested": {"inner": 1}},
                }
            )

    def test_flatten_event_raises_on_list_in_properties(self):
        from kimi_cli.telemetry.transport import _flatten_event

        with pytest.raises(TypeError, match="property.items"):
            _flatten_event({"event": "x", "timestamp": 1.0, "properties": {"items": [1, 2, 3]}})

    def test_flatten_event_raises_on_nested_dict_in_context(self):
        from kimi_cli.telemetry.transport import _flatten_event

        with pytest.raises(TypeError, match="context.meta"):
            _flatten_event(
                {
                    "event": "x",
                    "timestamp": 1.0,
                    "context": {"meta": {"nested": True}},
                }
            )

    def test_build_payload_user_id_at_top(self):
        from kimi_cli.telemetry.transport import _build_payload

        payload = _build_payload(
            [{"event": "started", "timestamp": 1.0, "properties": {}}],
            device_id="dev-1",
        )
        assert payload["user_id"] == "kfc_device_id_dev-1"
        assert "events" in payload

    def test_build_payload_events_are_flat_and_prefixed(self):
        from kimi_cli.telemetry.transport import _build_payload

        payload = _build_payload(
            [
                {
                    "event_id": "e1",
                    "event": "tool_call",
                    "timestamp": 1.0,
                    "device_id": "dev-1",
                    "session_id": "sess-1",
                    "properties": {"tool_name": "bash", "approved": True},
                    "context": {"version": "1.0", "platform": "darwin"},
                }
            ],
            device_id="dev-1",
        )
        event = payload["events"][0]
        assert event["event"] == "kfc_tool_call"
        assert event["event_id"] == "e1"
        assert event["device_id"] == "dev-1"
        assert event["session_id"] == "sess-1"
        assert event["property_tool_name"] == "bash"
        assert event["property_approved"] is True
        assert event["context_version"] == "1.0"
        assert event["context_platform"] == "darwin"
        assert "properties" not in event
        assert "context" not in event

    def test_build_payload_does_not_mutate_input(self):
        from kimi_cli.telemetry.transport import _build_payload

        events = [{"event": "started", "timestamp": 1.0, "properties": {"x": 1}}]
        _build_payload(events, device_id="dev-1")
        assert events[0]["event"] == "started"
        assert events[0]["properties"] == {"x": 1}

    @pytest.mark.asyncio
    async def test_send_drops_events_on_schema_violation(self, tmp_path: Path):
        """A non-primitive value in properties must drop the batch (not loop on disk).

        Retrying would hit the same TypeError on every reload, so falling
        back to disk would create a permanently stuck file.
        """
        transport = AsyncTransport(
            device_id="dev-bad",
            endpoint="https://mock.test/events",
            retry_backoffs_s=(),
        )
        # properties value is a dict — violates _assert_primitive.
        events_in = [
            {"event": "bad", "timestamp": 1.0, "properties": {"nested": {"x": 1}}},
        ]

        sent = AsyncMock()
        with (
            patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path),
            patch.object(transport, "_send_http", new=sent),
        ):
            # Must not raise — schema error is caught and events dropped.
            await transport.send(events_in)

        # No HTTP attempt
        sent.assert_not_awaited()
        # No disk fallback (would loop forever)
        assert list(tmp_path.glob("failed_*.jsonl")) == []

    @pytest.mark.asyncio
    async def test_send_persists_nested_shape_on_failure(self, tmp_path: Path):
        """save_to_disk must write the original nested events, not the flat payload."""
        from kimi_cli.telemetry.transport import _TransientError

        transport = AsyncTransport(
            device_id="dev-disk",
            endpoint="https://mock.test/events",
            retry_backoffs_s=(),
        )
        events_in = [
            {
                "event": "tool_call",
                "timestamp": 1.0,
                "properties": {"tool_name": "bash"},
                "context": {"version": "1.0"},
            }
        ]

        with (
            patch("kimi_cli.telemetry.transport._telemetry_dir", return_value=tmp_path),
            patch.object(
                transport,
                "_send_http",
                new_callable=AsyncMock,
                side_effect=_TransientError("503"),
            ),
        ):
            await transport.send(events_in)

        saved_files = list(tmp_path.glob("failed_*.jsonl"))
        assert len(saved_files) == 1
        persisted = json.loads(saved_files[0].read_text().strip())
        # Bare name + nested shape preserved — no prefix, no flattening.
        assert persisted["event"] == "tool_call"
        assert persisted["properties"] == {"tool_name": "bash"}
        assert persisted["context"] == {"version": "1.0"}
        assert "property_tool_name" not in persisted
        assert "user_id" not in persisted

"""Tests for telemetry event behavior and schema correctness.

These tests exercise the telemetry API directly and verify that calls to
track() and related helpers produce the expected event names, properties,
queue entries, and sink-forwarded payloads under the correct conditions.
They do NOT verify that specific production UI/soul call sites are still
instrumented — that coverage belongs in integration tests.
Transport/infrastructure tests are in test_telemetry.py.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import kimi_cli.telemetry as telemetry_mod
from kimi_cli.telemetry import attach_sink, disable, set_context, track
from kimi_cli.telemetry.sink import EventSink
from kimi_cli.telemetry.transport import AsyncTransport

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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


def _collect_events() -> list[dict[str, Any]]:
    """Return a snapshot of queued events."""
    return list(telemetry_mod._event_queue)


def _collect_sink_events(sink_mock: MagicMock) -> list[dict[str, Any]]:
    """Extract events forwarded to a mock sink."""
    return [call[0][0] for call in sink_mock.accept.call_args_list]


# ---------------------------------------------------------------------------
# 1. Slash command counting correctness
# ---------------------------------------------------------------------------


class TestSlashCommandCounting:
    """Verify that slash commands emit exactly one kimi_input_command event."""

    def test_shell_slash_command_tracks_once(self):
        """A shell-level slash command emits kimi_input_command with the command name."""
        # Simulate what _run_slash_command does: one track call
        track("kimi_input_command", command="model")
        events = _collect_events()
        matching = [e for e in events if e["event"] == "kimi_input_command"]
        assert len(matching) == 1
        assert matching[0]["properties"]["command"] == "model"

    def test_soul_slash_command_tracks_once(self):
        """A soul-level slash command emits kimi_input_command (not double-counted)."""
        # Soul-level commands are tracked at the shell layer before dispatch
        track("kimi_input_command", command="compact")
        events = _collect_events()
        matching = [e for e in events if e["event"] == "kimi_input_command"]
        assert len(matching) == 1
        assert matching[0]["properties"]["command"] == "compact"

    def test_invalid_command_tracks_separate_event(self):
        """Invalid slash commands emit kimi_input_command_invalid, not kimi_input_command."""
        track("kimi_input_command_invalid")
        events = _collect_events()
        assert any(e["event"] == "kimi_input_command_invalid" for e in events)
        assert not any(e["event"] == "kimi_input_command" for e in events)

    def test_no_double_counting_shell_and_soul(self):
        """Shell and soul layers must not both emit for the same command invocation."""
        # Simulate: only one track call per command execution path
        track("kimi_input_command", command="yolo")
        events = _collect_events()
        cmd_events = [e for e in events if e["event"] == "kimi_input_command"]
        assert len(cmd_events) == 1

    def test_command_property_is_string_enum(self):
        """Command property must be a string (enum-like), not an int or bool."""
        track("kimi_input_command", command="clear")
        event = _collect_events()[-1]
        assert isinstance(event["properties"]["command"], str)


# ---------------------------------------------------------------------------
# 2. Tool approval path completeness
# ---------------------------------------------------------------------------


class TestToolApprovalPaths:
    """Every approval path must emit exactly one of the two tool tracking events."""

    def test_manual_approve(self):
        """User clicking approve emits kimi_tool_approved."""
        track("kimi_tool_approved", tool_name="Bash")
        events = _collect_events()
        assert events[-1]["event"] == "kimi_tool_approved"
        assert events[-1]["properties"]["tool_name"] == "Bash"

    def test_approve_for_session(self):
        """'Approve for session' emits kimi_tool_approved (same as manual approve)."""
        track("kimi_tool_approved", tool_name="WriteFile")
        events = _collect_events()
        assert events[-1]["event"] == "kimi_tool_approved"

    def test_manual_reject(self):
        """User clicking reject emits kimi_tool_rejected."""
        track("kimi_tool_rejected", tool_name="Bash")
        events = _collect_events()
        assert events[-1]["event"] == "kimi_tool_rejected"
        assert events[-1]["properties"]["tool_name"] == "Bash"

    def test_cancelled_approval(self):
        """ApprovalCancelledError (e.g. Esc) emits kimi_tool_rejected."""
        track("kimi_tool_rejected", tool_name="Bash")
        events = _collect_events()
        assert events[-1]["event"] == "kimi_tool_rejected"

    def test_approval_events_are_mutually_exclusive(self):
        """Each approval path emits exactly one event — they never overlap."""
        track("kimi_tool_approved", tool_name="Bash")
        events = _collect_events()
        approval_events = [
            e for e in events if e["event"] in ("kimi_tool_approved", "kimi_tool_rejected")
        ]
        assert len(approval_events) == 1

    def test_tool_name_always_present(self):
        """All tool approval events include tool_name."""
        for event_name in ("kimi_tool_approved", "kimi_tool_rejected"):
            telemetry_mod._event_queue.clear()
            track(event_name, tool_name="SomeTool")
            event = _collect_events()[-1]
            assert "tool_name" in event["properties"], f"{event_name} missing tool_name"


# ---------------------------------------------------------------------------
# 3. API error classification
# ---------------------------------------------------------------------------


class TestAPIErrorClassification:
    """Verify the error_type mapping in kimi_api_error events."""

    def _classify(self, exc: Exception) -> str:
        """Replicate the classification logic from kimisoul.py for testing."""
        from kosong.chat_provider import APIConnectionError, APIStatusError, APITimeoutError

        error_type = "other"
        if isinstance(exc, APIStatusError):
            status = getattr(exc, "status_code", getattr(exc, "status", 0))
            if status == 429:
                error_type = "rate_limit"
            elif status in (401, 403):
                error_type = "auth"
            else:
                error_type = "api"
        elif isinstance(exc, APIConnectionError):
            error_type = "network"
        elif isinstance(exc, (APITimeoutError, TimeoutError)):
            error_type = "timeout"
        return error_type

    def test_429_maps_to_rate_limit(self):
        from kosong.chat_provider import APIStatusError

        exc = APIStatusError.__new__(APIStatusError)
        exc.status_code = 429
        assert self._classify(exc) == "rate_limit"

    def test_401_maps_to_auth(self):
        from kosong.chat_provider import APIStatusError

        exc = APIStatusError.__new__(APIStatusError)
        exc.status_code = 401
        assert self._classify(exc) == "auth"

    def test_403_maps_to_auth(self):
        from kosong.chat_provider import APIStatusError

        exc = APIStatusError.__new__(APIStatusError)
        exc.status_code = 403
        assert self._classify(exc) == "auth"

    def test_500_maps_to_api(self):
        from kosong.chat_provider import APIStatusError

        exc = APIStatusError.__new__(APIStatusError)
        exc.status_code = 500
        assert self._classify(exc) == "api"

    def test_502_maps_to_api(self):
        from kosong.chat_provider import APIStatusError

        exc = APIStatusError.__new__(APIStatusError)
        exc.status_code = 502
        assert self._classify(exc) == "api"

    def test_connection_error_maps_to_network(self):
        from kosong.chat_provider import APIConnectionError

        exc = APIConnectionError.__new__(APIConnectionError)
        assert self._classify(exc) == "network"

    def test_api_timeout_maps_to_timeout(self):
        from kosong.chat_provider import APITimeoutError

        exc = APITimeoutError.__new__(APITimeoutError)
        assert self._classify(exc) == "timeout"

    def test_builtin_timeout_maps_to_timeout(self):
        exc = TimeoutError("timed out")
        assert self._classify(exc) == "timeout"

    def test_generic_exception_maps_to_other(self):
        exc = RuntimeError("unexpected")
        assert self._classify(exc) == "other"

    def test_classification_emits_correct_track_call(self):
        """The classified error_type is passed as a string property."""
        track("kimi_api_error", error_type="rate_limit")
        event = _collect_events()[-1]
        assert event["event"] == "kimi_api_error"
        assert event["properties"]["error_type"] == "rate_limit"
        assert isinstance(event["properties"]["error_type"], str)


# ---------------------------------------------------------------------------
# 4. Cancel / interrupt correctness
# ---------------------------------------------------------------------------


class TestCancelInterrupt:
    """Verify cancel and interrupt events."""

    def test_esc_emits_kimi_cancel(self):
        """Pressing Esc during streaming emits kimi_cancel."""
        track("kimi_cancel")
        events = _collect_events()
        assert events[-1]["event"] == "kimi_cancel"

    def test_esc_in_question_panel_emits_dismissed(self):
        """Pressing Esc on question panel emits kimi_question_dismissed, not kimi_cancel."""
        track("kimi_question_dismissed")
        events = _collect_events()
        assert events[-1]["event"] == "kimi_question_dismissed"
        assert not any(e["event"] == "kimi_cancel" for e in events)

    def test_run_cancelled_emits_turn_interrupted(self):
        """RunCancelled exception emits kimi_turn_interrupted with at_step."""
        track("kimi_turn_interrupted", at_step=3)
        event = _collect_events()[-1]
        assert event["event"] == "kimi_turn_interrupted"
        assert event["properties"]["at_step"] == 3

    def test_turn_interrupted_at_step_is_int(self):
        """at_step property must be an integer."""
        track("kimi_turn_interrupted", at_step=0)
        event = _collect_events()[-1]
        assert isinstance(event["properties"]["at_step"], int)

    def test_cancel_and_dismissed_are_distinct(self):
        """kimi_cancel and kimi_question_dismissed are different events."""
        track("kimi_cancel")
        track("kimi_question_dismissed")
        events = _collect_events()
        event_names = [e["event"] for e in events]
        assert "kimi_cancel" in event_names
        assert "kimi_question_dismissed" in event_names


# ---------------------------------------------------------------------------
# 5. Core infrastructure edge cases
# ---------------------------------------------------------------------------


class TestInfrastructureEdgeCases:
    """Tests for telemetry infrastructure behavior under edge conditions."""

    def test_disabled_track_is_noop(self):
        """After disable(), track() is a silent no-op."""
        disable()
        track("should_be_dropped")
        assert len(telemetry_mod._event_queue) == 0

    def test_disabled_with_sink_clears_buffer(self):
        """disable() clears both queue and sink buffer."""
        mock_sink = MagicMock(spec=EventSink)
        attach_sink(mock_sink)
        track("event_before")
        disable()
        mock_sink.clear_buffer.assert_called_once()

    def test_flush_sync_empty_buffer_is_noop(self):
        """flush_sync with empty buffer does not call transport."""
        transport = MagicMock(spec=AsyncTransport)
        sink = EventSink(transport, version="1.0.0")
        sink.flush_sync()
        transport.save_to_disk.assert_not_called()

    def test_flush_sync_writes_to_disk(self):
        """flush_sync (atexit) saves events to disk, not HTTP."""
        transport = MagicMock(spec=AsyncTransport)
        sink = EventSink(transport, version="1.0.0")
        sink.accept({"event": "test", "timestamp": 1.0, "properties": {}})
        sink.flush_sync()
        transport.save_to_disk.assert_called_once()
        events = transport.save_to_disk.call_args[0][0]
        assert len(events) == 1

    @pytest.mark.asyncio
    async def test_transport_send_falls_back_to_disk_on_transient_error(self):
        """Transient HTTP errors trigger disk fallback via send()."""
        from kimi_cli.telemetry.transport import _TransientError

        transport = AsyncTransport(endpoint="https://mock.test/events")
        with (
            patch.object(
                transport, "_send_http", new_callable=AsyncMock, side_effect=_TransientError("503")
            ),
            patch.object(transport, "save_to_disk") as mock_save,
        ):
            await transport.send([{"event": "test", "timestamp": 1.0}])
            mock_save.assert_called_once()
            saved_events = mock_save.call_args[0][0]
            assert len(saved_events) == 1
            assert saved_events[0]["event"] == "test"

    def test_queue_overflow_preserves_newest(self):
        """When queue overflows, oldest events are dropped, newest kept."""
        for i in range(telemetry_mod._MAX_QUEUE_SIZE + 50):
            track(f"evt_{i}")
        events = _collect_events()
        assert len(events) == telemetry_mod._MAX_QUEUE_SIZE
        # Newest event should be last
        assert events[-1]["event"] == f"evt_{telemetry_mod._MAX_QUEUE_SIZE + 49}"
        # Oldest surviving event
        assert events[0]["event"] == "evt_50"

    @pytest.mark.asyncio
    async def test_disk_file_expiry(self, tmp_path: Path):
        """Files older than 7 days are deleted without retry."""
        import os

        failed_file = tmp_path / "failed_old.jsonl"
        failed_file.write_text('{"event":"old","timestamp":1.0}\n')
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


# ---------------------------------------------------------------------------
# 6. Specific event property correctness
# ---------------------------------------------------------------------------


class TestEventPropertyCorrectness:
    """Verify specific events carry the right property types and values."""

    def test_yolo_toggle_enabled_bool(self):
        """kimi_yolo_toggle.enabled is a bool."""
        track("kimi_yolo_toggle", enabled=True)
        event = _collect_events()[-1]
        assert isinstance(event["properties"]["enabled"], bool)
        assert event["properties"]["enabled"] is True

        telemetry_mod._event_queue.clear()
        track("kimi_yolo_toggle", enabled=False)
        event = _collect_events()[-1]
        assert event["properties"]["enabled"] is False

    def test_shortcut_mode_switch_to_mode(self):
        """kimi_shortcut_mode_switch.to_mode is a string enum."""
        track("kimi_shortcut_mode_switch", to_mode="agent")
        event = _collect_events()[-1]
        assert event["properties"]["to_mode"] == "agent"
        assert isinstance(event["properties"]["to_mode"], str)

    def test_question_answered_method_enum(self):
        """kimi_question_answered.method is a string enum."""
        for method in ("number_key", "enter", "escape"):
            telemetry_mod._event_queue.clear()
            track("kimi_question_answered", method=method)
            event = _collect_events()[-1]
            assert event["properties"]["method"] == method

    def test_tool_error_has_tool_name(self):
        """kimi_tool_error includes tool_name property."""
        track("kimi_tool_error", tool_name="Bash")
        event = _collect_events()[-1]
        assert event["event"] == "kimi_tool_error"
        assert event["properties"]["tool_name"] == "Bash"

    def test_exit_event_has_duration(self):
        """kimi_exit includes duration_s (float)."""
        track("kimi_exit", duration_s=123.456)
        event = _collect_events()[-1]
        assert isinstance(event["properties"]["duration_s"], float)

    def test_startup_perf_duration_ms_is_int(self):
        """kimi_startup_perf.duration_ms is an int (milliseconds)."""
        track("kimi_startup_perf", duration_ms=342)
        event = _collect_events()[-1]
        assert isinstance(event["properties"]["duration_ms"], int)

    def test_model_switch_has_model_string(self):
        """kimi_model_switch.model is a string."""
        track("kimi_model_switch", model="kimi-k2.5")
        event = _collect_events()[-1]
        assert event["properties"]["model"] == "kimi-k2.5"

    def test_hook_triggered_properties(self):
        """kimi_hook_triggered has event_type and action."""
        track("kimi_hook_triggered", event_type="PreToolUse", action="block")
        event = _collect_events()[-1]
        assert event["properties"]["event_type"] == "PreToolUse"
        assert event["properties"]["action"] == "block"

    def test_started_event_has_yolo(self):
        """kimi_started includes resumed (bool) and yolo (bool)."""
        track("kimi_started", resumed=False, yolo=True)
        event = _collect_events()[-1]
        assert event["event"] == "kimi_started"
        assert event["properties"]["resumed"] is False
        assert event["properties"]["yolo"] is True

    def test_background_task_completed_properties(self):
        """kimi_background_task_completed has success (bool) and duration_s (float)."""
        track("kimi_background_task_completed", success=True, duration_s=45.2)
        event = _collect_events()[-1]
        assert event["properties"]["success"] is True
        assert isinstance(event["properties"]["duration_s"], float)

    def test_background_task_no_event_without_start_time(self):
        """_mark_task_completed must NOT emit track when started_at is None."""
        from kimi_cli.background.manager import BackgroundTaskManager
        from kimi_cli.background.models import TaskRuntime

        runtime = TaskRuntime(status="running", started_at=None)
        mock_store = MagicMock()
        mock_store.read_runtime.return_value = runtime

        manager = object.__new__(BackgroundTaskManager)
        manager._store = mock_store

        with patch("kimi_cli.telemetry.track") as mock_track:
            manager._mark_task_completed("task-no-start")

        mock_track.assert_not_called()

    def test_mark_task_killed_emits_completed_event(self):
        """_mark_task_killed must emit kimi_background_task_completed(success=False)."""
        from kimi_cli.background.manager import BackgroundTaskManager
        from kimi_cli.background.models import TaskRuntime

        runtime = TaskRuntime(status="running", started_at=1000.0)

        mock_store = MagicMock()
        mock_store.read_runtime.return_value = runtime

        manager = object.__new__(BackgroundTaskManager)
        manager._store = mock_store

        with patch("kimi_cli.telemetry.track") as mock_track:
            manager._mark_task_killed("task-123", "Killed by user")

        mock_track.assert_called_once()
        call_args = mock_track.call_args
        assert call_args[0][0] == "kimi_background_task_completed"
        assert call_args[1]["success"] is False
        assert "duration_s" in call_args[1]

    def test_mark_task_killed_no_event_without_start_time(self):
        """_mark_task_killed must NOT emit track when started_at is None."""
        from kimi_cli.background.manager import BackgroundTaskManager
        from kimi_cli.background.models import TaskRuntime

        runtime = TaskRuntime(status="running", started_at=None)
        mock_store = MagicMock()
        mock_store.read_runtime.return_value = runtime

        manager = object.__new__(BackgroundTaskManager)
        manager._store = mock_store

        with patch("kimi_cli.telemetry.track") as mock_track:
            manager._mark_task_killed("task-no-start", "Killed by user")

        mock_track.assert_not_called()

    def test_timestamp_is_recent(self):
        """All events get a timestamp close to now."""
        before = time.time()
        track("kimi_test")
        after = time.time()
        event = _collect_events()[-1]
        assert before <= event["timestamp"] <= after


# ---------------------------------------------------------------------------
# 7. Context enrichment
# ---------------------------------------------------------------------------


class TestContextEnrichment:
    """Verify EventSink enriches events correctly."""

    def test_enrichment_adds_version_platform(self):
        """Enriched events include version and platform."""
        transport = MagicMock(spec=AsyncTransport)
        sink = EventSink(transport, version="2.0.0", model="test-model")
        sink.accept({"event": "test", "timestamp": 1.0, "properties": {}})
        sink.flush_sync()
        buffered = transport.save_to_disk.call_args[0][0][0]
        assert buffered["context"]["version"] == "2.0.0"
        assert buffered["context"]["model"] == "test-model"
        assert "platform" in buffered["context"]
        assert "arch" in buffered["context"]

    def test_enrichment_does_not_mutate_input(self):
        """accept() must not mutate the caller's dict."""
        transport = MagicMock(spec=AsyncTransport)
        sink = EventSink(transport, version="1.0.0")
        original = {"event": "test", "timestamp": 1.0, "properties": {}}
        sink.accept(original)
        assert "context" not in original

    def test_model_set_at_init(self):
        """Model passed at init appears in enriched context."""
        transport = MagicMock(spec=AsyncTransport)
        sink = EventSink(transport, version="1.0.0", model="test-model")
        sink.accept({"event": "test", "timestamp": 1.0, "properties": {}})
        sink.flush_sync()
        buffered = transport.save_to_disk.call_args[0][0][0]
        assert buffered["context"]["model"] == "test-model"

    def test_device_and_session_ids_propagate(self):
        """device_id and session_id set via set_context() appear in events."""
        set_context(device_id="dev-abc", session_id="sess-xyz")
        track("test_event")
        event = _collect_events()[-1]
        assert event["device_id"] == "dev-abc"
        assert event["session_id"] == "sess-xyz"

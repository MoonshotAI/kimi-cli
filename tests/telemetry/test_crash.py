"""Tests for crash telemetry handlers (sys.excepthook + asyncio)."""

from __future__ import annotations

import asyncio
import sys
from typing import Any
from unittest.mock import MagicMock

import click
import pytest

import kimi_cli.telemetry as telemetry_mod
import kimi_cli.telemetry.crash as crash_mod
from kimi_cli.telemetry import attach_sink
from kimi_cli.telemetry.crash import (
    install_asyncio_handler,
    install_crash_handlers,
    set_phase,
)
from kimi_cli.telemetry.sink import EventSink


@pytest.fixture(autouse=True)
def _reset_state():
    """Reset telemetry + crash module state around each test."""
    # telemetry module
    telemetry_mod._event_queue.clear()
    telemetry_mod._device_id = None
    telemetry_mod._session_id = None
    telemetry_mod._client_info = None
    telemetry_mod._session_started_sessions.clear()
    telemetry_mod._sink = None
    telemetry_mod._disabled = False
    # crash module
    original_excepthook = sys.excepthook
    original_crash_excepthook_backup = crash_mod._original_excepthook
    original_crash_asyncio_backup = crash_mod._original_asyncio_handler
    original_phase = crash_mod._phase
    yield
    # restore
    sys.excepthook = original_excepthook
    crash_mod._original_excepthook = original_crash_excepthook_backup
    crash_mod._original_asyncio_handler = original_crash_asyncio_backup
    crash_mod._phase = original_phase
    telemetry_mod._event_queue.clear()
    telemetry_mod._device_id = None
    telemetry_mod._session_id = None
    telemetry_mod._client_info = None
    telemetry_mod._session_started_sessions.clear()
    telemetry_mod._sink = None
    telemetry_mod._disabled = False


def _invoke_excepthook(exc: BaseException) -> None:
    """Simulate Python calling sys.excepthook with a raised exception."""
    try:
        raise exc
    except BaseException as e:
        sys.excepthook(type(e), e, e.__traceback__)


class TestExcepthook:
    def test_runtime_error_produces_crash_event(self):
        """RuntimeError triggers a crash event with correct fields."""
        install_crash_handlers()
        set_phase("runtime")

        # Swallow the original handler's traceback output
        crash_mod._original_excepthook = lambda *a, **kw: None

        _invoke_excepthook(RuntimeError("boom"))

        assert len(telemetry_mod._event_queue) == 1
        event = telemetry_mod._event_queue[0]
        assert event["event"] == "crash"
        assert event["properties"]["error_type"] == "RuntimeError"
        assert event["properties"]["where"] == "runtime"
        assert event["properties"]["source"] == "excepthook"

    def test_keyboard_interrupt_ignored(self):
        """KeyboardInterrupt does not produce a crash event."""
        install_crash_handlers()
        crash_mod._original_excepthook = lambda *a, **kw: None

        _invoke_excepthook(KeyboardInterrupt())

        assert len(telemetry_mod._event_queue) == 0

    def test_system_exit_ignored(self):
        """SystemExit does not produce a crash event."""
        install_crash_handlers()
        crash_mod._original_excepthook = lambda *a, **kw: None

        _invoke_excepthook(SystemExit(1))

        assert len(telemetry_mod._event_queue) == 0

    def test_click_usage_error_ignored(self):
        """click.UsageError (user input error) does not produce a crash event."""
        install_crash_handlers()
        crash_mod._original_excepthook = lambda *a, **kw: None

        _invoke_excepthook(click.UsageError("invalid option"))

        assert len(telemetry_mod._event_queue) == 0

    def test_original_handler_preserved(self):
        """Original excepthook is called even when we record the crash."""
        original_called: dict[str, Any] = {"called": False, "args": None}

        def fake_original(exc_type, exc, tb):
            original_called["called"] = True
            original_called["args"] = (exc_type, exc, tb)

        sys.excepthook = fake_original
        install_crash_handlers()

        _invoke_excepthook(ValueError("boom"))

        assert original_called["called"] is True
        assert original_called["args"] is not None
        exc_type, exc, _tb = original_called["args"]
        assert exc_type is ValueError
        assert str(exc) == "boom"

    def test_original_handler_called_for_ignored_exceptions(self):
        """Ignored exceptions still get passed to the original handler (no event)."""
        calls: list[type[BaseException]] = []
        sys.excepthook = lambda et, e, tb: calls.append(et)
        install_crash_handlers()

        _invoke_excepthook(KeyboardInterrupt())
        _invoke_excepthook(SystemExit(1))

        assert calls == [KeyboardInterrupt, SystemExit]
        assert len(telemetry_mod._event_queue) == 0

    def test_phase_reflected_in_event(self):
        """The current phase is recorded in the crash event's `where` field."""
        install_crash_handlers()
        crash_mod._original_excepthook = lambda *a, **kw: None

        set_phase("startup")
        _invoke_excepthook(RuntimeError("early boom"))

        assert telemetry_mod._event_queue[0]["properties"]["where"] == "startup"


class TestAsyncioHandler:
    @pytest.mark.asyncio
    async def test_task_exception_produces_crash_event(self):
        """Unhandled task exception is recorded with source=asyncio_task."""
        loop = asyncio.get_running_loop()
        # Stub the default handler so pytest-asyncio doesn't fail the test
        original_default = loop.default_exception_handler
        loop.default_exception_handler = lambda ctx: None  # type: ignore[method-assign]
        try:
            install_asyncio_handler(loop)
            set_phase("runtime")

            loop.call_exception_handler(
                {"message": "task failed", "exception": RuntimeError("async boom")}
            )

            assert len(telemetry_mod._event_queue) == 1
            event = telemetry_mod._event_queue[0]
            assert event["event"] == "crash"
            assert event["properties"]["error_type"] == "RuntimeError"
            assert event["properties"]["where"] == "runtime"
            assert event["properties"]["source"] == "asyncio_task"
        finally:
            loop.default_exception_handler = original_default  # type: ignore[method-assign]
            loop.set_exception_handler(None)

    @pytest.mark.asyncio
    async def test_cancelled_error_ignored(self):
        """asyncio.CancelledError does not produce a crash event."""
        loop = asyncio.get_running_loop()
        original_default = loop.default_exception_handler
        loop.default_exception_handler = lambda ctx: None  # type: ignore[method-assign]
        try:
            install_asyncio_handler(loop)

            loop.call_exception_handler(
                {"message": "cancelled", "exception": asyncio.CancelledError()}
            )

            assert len(telemetry_mod._event_queue) == 0
        finally:
            loop.default_exception_handler = original_default  # type: ignore[method-assign]
            loop.set_exception_handler(None)

    @pytest.mark.asyncio
    async def test_original_handler_preserved(self):
        """An existing custom asyncio exception handler is still invoked."""
        captured: list[dict[str, Any]] = []

        def custom_handler(loop: asyncio.AbstractEventLoop, ctx: dict[str, Any]) -> None:
            captured.append(ctx)

        loop = asyncio.get_running_loop()
        loop.set_exception_handler(custom_handler)
        install_asyncio_handler(loop)

        try:
            loop.call_exception_handler(
                {"message": "task failed", "exception": RuntimeError("boom")}
            )

            assert len(captured) == 1
            assert isinstance(captured[0]["exception"], RuntimeError)
            assert len(telemetry_mod._event_queue) == 1
        finally:
            loop.set_exception_handler(None)

    @pytest.mark.asyncio
    async def test_default_handler_used_when_no_original(self):
        """When no prior handler was set, the default handler is invoked."""
        loop = asyncio.get_running_loop()
        calls: list[dict[str, Any]] = []
        loop.default_exception_handler = lambda ctx: calls.append(ctx)  # type: ignore[method-assign]
        install_asyncio_handler(loop)

        try:
            loop.call_exception_handler(
                {"message": "task failed", "exception": RuntimeError("boom")}
            )
            assert len(calls) == 1
        finally:
            loop.set_exception_handler(None)


class TestCrashEventViaSink:
    def test_crash_event_routed_through_sink_when_attached(self):
        """A crash event recorded after sink attach goes to the sink."""
        mock_sink = MagicMock(spec=EventSink)
        attach_sink(mock_sink)
        install_crash_handlers()
        crash_mod._original_excepthook = lambda *a, **kw: None

        _invoke_excepthook(RuntimeError("boom"))

        mock_sink.accept.assert_called_once()
        event = mock_sink.accept.call_args[0][0]
        assert event["event"] == "crash"
        assert event["properties"]["source"] == "excepthook"


class TestPhase:
    def test_set_phase_updates_value(self):
        set_phase("runtime")
        assert crash_mod._phase == "runtime"
        set_phase("shutdown")
        assert crash_mod._phase == "shutdown"


class TestIdempotentInstall:
    def test_install_crash_handlers_is_idempotent(self):
        """Calling install_crash_handlers twice does not double-wrap itself."""
        install_crash_handlers()
        first = sys.excepthook
        saved_original = crash_mod._original_excepthook

        install_crash_handlers()

        # Excepthook pointer unchanged
        assert sys.excepthook is first
        # And critically: _original_excepthook was NOT overwritten with
        # our own hook (which would cause infinite recursion when invoked).
        assert crash_mod._original_excepthook is saved_original
        assert crash_mod._original_excepthook is not crash_mod._excepthook

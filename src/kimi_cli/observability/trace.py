"""
Tracing utilities for Kimi CLI.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from typing import TYPE_CHECKING, Any

from kimi_cli.observability.sdk import get_tracer, is_initialized

if TYPE_CHECKING:
    from opentelemetry.trace import Span, SpanKind, Status


class NoOpSpan:
    """A no-op span implementation for when tracing is disabled."""

    def set_attribute(self, key: str, value: Any) -> None:
        pass

    def set_attributes(self, attributes: dict[str, Any]) -> None:
        pass

    def add_event(self, name: str, attributes: dict[str, Any] | None = None) -> None:
        pass

    def set_status(self, status: Status) -> None:
        pass

    def record_exception(self, exception: BaseException) -> None:
        pass

    def end(self) -> None:
        pass

    def is_recording(self) -> bool:
        return False


_NOOP_SPAN = NoOpSpan()


def get_current_span() -> Span | NoOpSpan:
    """
    Get the current active span.

    Returns:
        The current span or a NoOpSpan if tracing is not initialized.
    """
    if not is_initialized():
        return _NOOP_SPAN

    tracer = get_tracer()
    if tracer is None:
        return _NOOP_SPAN

    from opentelemetry import trace

    span = trace.get_current_span()
    return span


@contextmanager
def trace_span(
    name: str,
    *,
    kind: SpanKind | None = None,
    attributes: dict[str, Any] | None = None,
) -> Iterator[Span | NoOpSpan]:
    """
    Create a new span as a context manager.

    This is a synchronous context manager for use in sync code.

    Args:
        name: The name of the span.
        kind: The kind of span (INTERNAL, SERVER, CLIENT, etc.).
        attributes: Initial attributes for the span.

    Yields:
        The created span or a NoOpSpan if tracing is disabled.

    Example:
        with trace_span("my_operation", attributes={"key": "value"}) as span:
            span.set_attribute("result", "success")
            # ... do work ...
    """
    tracer = get_tracer()
    if tracer is None:
        yield _NOOP_SPAN
        return

    from opentelemetry.trace import SpanKind as OTelSpanKind
    from opentelemetry.trace import Status, StatusCode

    span_kind = kind if kind is not None else OTelSpanKind.INTERNAL

    with tracer.start_as_current_span(
        name,
        kind=span_kind,
        attributes=attributes,
    ) as span:
        try:
            yield span
        except Exception as e:
            span.set_status(Status(StatusCode.ERROR, str(e)))
            span.record_exception(e)
            raise


@asynccontextmanager
async def trace_span_async(
    name: str,
    *,
    kind: SpanKind | None = None,
    attributes: dict[str, Any] | None = None,
) -> AsyncIterator[Span | NoOpSpan]:
    """
    Create a new span as an async context manager.

    This is identical to trace_span but for async code.

    Args:
        name: The name of the span.
        kind: The kind of span (INTERNAL, SERVER, CLIENT, etc.).
        attributes: Initial attributes for the span.

    Yields:
        The created span or a NoOpSpan if tracing is disabled.

    Example:
        async with trace_span_async("my_async_operation") as span:
            span.set_attribute("result", "success")
            await async_work()
    """
    # The underlying OTel context manager is synchronous, so we just wrap it
    with trace_span(name, kind=kind, attributes=attributes) as span:
        yield span


def start_span(
    name: str,
    *,
    kind: SpanKind | None = None,
    attributes: dict[str, Any] | None = None,
) -> Span | NoOpSpan:
    """
    Start a new span without using a context manager.

    The caller is responsible for calling span.end() when done.

    Args:
        name: The name of the span.
        kind: The kind of span.
        attributes: Initial attributes for the span.

    Returns:
        The created span or a NoOpSpan if tracing is disabled.

    Example:
        span = start_span("long_operation")
        try:
            # ... do work ...
            span.set_attribute("result", "success")
        finally:
            span.end()
    """
    tracer = get_tracer()
    if tracer is None:
        return _NOOP_SPAN

    from opentelemetry.trace import SpanKind as OTelSpanKind

    span_kind = kind if kind is not None else OTelSpanKind.INTERNAL

    return tracer.start_span(
        name,
        kind=span_kind,
        attributes=attributes,
    )


def add_span_event(name: str, attributes: dict[str, Any] | None = None) -> None:
    """
    Add an event to the current span.

    Args:
        name: The name of the event.
        attributes: Attributes for the event.
    """
    span = get_current_span()
    span.add_event(name, attributes=attributes)


def set_span_attribute(key: str, value: Any) -> None:
    """
    Set an attribute on the current span.

    Args:
        key: The attribute key.
        value: The attribute value.
    """
    span = get_current_span()
    span.set_attribute(key, value)


def set_span_attributes(attributes: dict[str, Any]) -> None:
    """
    Set multiple attributes on the current span.

    Args:
        attributes: A dictionary of attribute key-value pairs.
    """
    span = get_current_span()
    span.set_attributes(attributes)

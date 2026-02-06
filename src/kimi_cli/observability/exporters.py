# pyright: reportUnknownVariableType=false
"""
OpenTelemetry exporters for different backends.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from kimi_cli.observability.config import ObservabilityConfig

if TYPE_CHECKING:
    from opentelemetry.sdk.metrics.export import MetricReader
    from opentelemetry.sdk.trace import SpanProcessor


def create_span_processor(config: ObservabilityConfig) -> SpanProcessor | None:
    """
    Create a span processor based on the export target configuration.

    Args:
        config: Observability configuration.

    Returns:
        A SpanProcessor instance or None if export target is 'none'.
    """
    if config.export_target == "none":
        return None

    if config.export_target == "console":
        return _create_console_span_processor()
    elif config.export_target == "otlp":
        return _create_otlp_span_processor(config)
    elif config.export_target == "file":
        return _create_file_span_processor(config)

    return None


def create_metric_reader(config: ObservabilityConfig) -> MetricReader | None:
    """
    Create a metric reader based on the export target configuration.

    Args:
        config: Observability configuration.

    Returns:
        A MetricReader instance or None if export target is 'none'.
    """
    if config.export_target == "none":
        return None

    if config.export_target == "console":
        return _create_console_metric_reader()
    elif config.export_target == "otlp":
        return _create_otlp_metric_reader(config)
    elif config.export_target == "file":
        return _create_file_metric_reader(config)

    return None


def _create_console_span_processor() -> SpanProcessor:
    """Create a console span processor for debugging."""
    from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor

    return SimpleSpanProcessor(ConsoleSpanExporter())


def _create_console_metric_reader() -> MetricReader:
    """Create a console metric reader for debugging."""
    from opentelemetry.sdk.metrics.export import (
        ConsoleMetricExporter,
        PeriodicExportingMetricReader,
    )

    return PeriodicExportingMetricReader(
        ConsoleMetricExporter(),
        export_interval_millis=60000,  # Export every 60 seconds
    )


def _create_otlp_span_processor(config: ObservabilityConfig) -> SpanProcessor:
    """Create an OTLP span processor."""
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    if config.otlp_protocol == "grpc":
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (  # pyright: ignore[reportMissingImports,reportUnknownVariableType]
            OTLPSpanExporter,
        )

        exporter = OTLPSpanExporter(  # pyright: ignore[reportUnknownVariableType]
            endpoint=config.otlp_endpoint,
            headers=config.otlp_headers or None,
        )
    else:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (  # pyright: ignore[reportMissingImports,reportUnknownVariableType]
            OTLPSpanExporter,
        )

        # HTTP exporter expects /v1/traces suffix
        endpoint = config.otlp_endpoint
        if not endpoint.endswith("/v1/traces"):
            endpoint = endpoint.rstrip("/") + "/v1/traces"
        exporter = OTLPSpanExporter(  # pyright: ignore[reportUnknownVariableType]
            endpoint=endpoint,
            headers=config.otlp_headers or None,
        )

    return BatchSpanProcessor(exporter)  # pyright: ignore[reportUnknownArgumentType]


def _create_otlp_metric_reader(config: ObservabilityConfig) -> MetricReader:
    """Create an OTLP metric reader."""
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

    if config.otlp_protocol == "grpc":
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (  # pyright: ignore[reportMissingImports,reportUnknownVariableType]
            OTLPMetricExporter,
        )

        exporter = OTLPMetricExporter(  # pyright: ignore[reportUnknownVariableType]
            endpoint=config.otlp_endpoint,
            headers=config.otlp_headers or None,
        )
    else:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import (  # pyright: ignore[reportMissingImports,reportUnknownVariableType]
            OTLPMetricExporter,
        )

        endpoint = config.otlp_endpoint
        if not endpoint.endswith("/v1/metrics"):
            endpoint = endpoint.rstrip("/") + "/v1/metrics"
        exporter = OTLPMetricExporter(  # pyright: ignore[reportUnknownVariableType]
            endpoint=endpoint,
            headers=config.otlp_headers or None,
        )

    return PeriodicExportingMetricReader(
        exporter,  # pyright: ignore[reportUnknownArgumentType]
        export_interval_millis=60000,
    )


def _create_file_span_processor(config: ObservabilityConfig) -> SpanProcessor:
    """Create a file-based span processor."""
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    from kimi_cli.observability.file_exporter import FileSpanExporter

    file_path = _resolve_file_path(config.file_path, "traces.jsonl")
    exporter = FileSpanExporter(file_path)
    return BatchSpanProcessor(exporter)  # pyright: ignore[reportArgumentType]


def _create_file_metric_reader(config: ObservabilityConfig) -> MetricReader:
    """Create a file-based metric reader."""
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

    from kimi_cli.observability.file_exporter import FileMetricExporter

    file_path = _resolve_file_path(config.file_path, "metrics.jsonl")
    exporter = FileMetricExporter(file_path)
    return PeriodicExportingMetricReader(
        exporter,  # pyright: ignore[reportArgumentType]
        export_interval_millis=60000,
    )


def _resolve_file_path(configured_path: str, default_filename: str) -> str:
    """Resolve the file path for file exporters."""
    from pathlib import Path

    from kimi_cli.share import get_share_dir

    if configured_path:
        path = Path(configured_path).expanduser()
        if path.is_dir():
            return str(path / default_filename)
        return str(path)

    # Default to share directory
    telemetry_dir = get_share_dir() / "telemetry"
    telemetry_dir.mkdir(parents=True, exist_ok=True)
    return str(telemetry_dir / default_filename)

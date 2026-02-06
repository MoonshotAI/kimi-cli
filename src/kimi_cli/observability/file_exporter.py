"""
File-based exporters for OpenTelemetry data.

These exporters write telemetry data to JSONL files for offline analysis.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from opentelemetry.sdk.metrics.export import (
        MetricExportResult,
        MetricsData,
    )
    from opentelemetry.sdk.trace import ReadableSpan
    from opentelemetry.sdk.trace.export import SpanExportResult


class FileSpanExporter:
    """Export spans to a JSONL file."""

    def __init__(self, file_path: str) -> None:
        self._file_path = Path(file_path)
        self._file_path.parent.mkdir(parents=True, exist_ok=True)
        self._file = None

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        """Export spans to the file."""
        from opentelemetry.sdk.trace.export import SpanExportResult

        try:
            with open(self._file_path, "a", encoding="utf-8") as f:
                for span in spans:
                    record = self._span_to_dict(span)
                    f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
            return SpanExportResult.SUCCESS
        except Exception as e:
            logger.error("Failed to export spans to file: {error}", error=e)
            return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        """Shutdown the exporter."""
        pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        """Force flush any buffered data."""
        return True

    @staticmethod
    def _span_to_dict(span: ReadableSpan) -> dict[str, Any]:
        """Convert a span to a dictionary for JSON serialization."""
        context = span.get_span_context()
        trace_id = format(context.trace_id, "032x") if context else "0" * 32
        span_id = format(context.span_id, "016x") if context else "0" * 16
        return {
            "type": "span",
            "timestamp": datetime.now(UTC).isoformat(),
            "trace_id": trace_id,
            "span_id": span_id,
            "parent_span_id": (format(span.parent.span_id, "016x") if span.parent else None),
            "name": span.name,
            "kind": span.kind.name if span.kind else None,
            "status": {
                "code": span.status.status_code.name,
                "description": span.status.description,
            },
            "start_time": span.start_time,
            "end_time": span.end_time,
            "attributes": dict(span.attributes) if span.attributes else {},
            "events": [
                {
                    "name": event.name,
                    "timestamp": event.timestamp,
                    "attributes": dict(event.attributes) if event.attributes else {},
                }
                for event in span.events
            ],
        }


class FileMetricExporter:
    """Export metrics to a JSONL file."""

    def __init__(self, file_path: str) -> None:
        self._file_path = Path(file_path)
        self._file_path.parent.mkdir(parents=True, exist_ok=True)

    def export(
        self,
        metrics_data: MetricsData,
        timeout_millis: float = 10000,
        **kwargs: Any,
    ) -> MetricExportResult:
        """Export metrics to the file."""
        from opentelemetry.sdk.metrics.export import MetricExportResult

        try:
            with open(self._file_path, "a", encoding="utf-8") as f:
                for resource_metrics in metrics_data.resource_metrics:
                    for scope_metrics in resource_metrics.scope_metrics:
                        for metric in scope_metrics.metrics:
                            record = self._metric_to_dict(metric)
                            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
            return MetricExportResult.SUCCESS
        except Exception as e:
            logger.error("Failed to export metrics to file: {error}", error=e)
            return MetricExportResult.FAILURE

    def shutdown(self, timeout_millis: float = 30000, **kwargs: Any) -> None:
        """Shutdown the exporter."""
        pass

    def force_flush(self, timeout_millis: float = 10000) -> bool:
        """Force flush any buffered data."""
        return True

    @staticmethod
    def _metric_to_dict(metric: Any) -> dict[str, Any]:
        """Convert a metric to a dictionary for JSON serialization."""
        data_points = []
        if hasattr(metric, "data") and hasattr(metric.data, "data_points"):
            for point in metric.data.data_points:
                point_dict: dict[str, Any] = {
                    "attributes": dict(point.attributes) if point.attributes else {},
                    "start_time": point.start_time_unix_nano,
                    "time": point.time_unix_nano,
                }
                # Handle different point types
                if hasattr(point, "value"):
                    point_dict["value"] = point.value
                if hasattr(point, "count"):
                    point_dict["count"] = point.count
                if hasattr(point, "sum"):
                    point_dict["sum"] = point.sum
                if hasattr(point, "bucket_counts"):
                    point_dict["bucket_counts"] = list(point.bucket_counts)
                if hasattr(point, "explicit_bounds"):
                    point_dict["explicit_bounds"] = list(point.explicit_bounds)
                data_points.append(point_dict)  # pyright: ignore[reportUnknownMemberType]

        return {
            "type": "metric",
            "timestamp": datetime.now(UTC).isoformat(),
            "name": metric.name,
            "description": metric.description,
            "unit": metric.unit,
            "data_points": data_points,
        }

"""
OpenTelemetry SDK initialization and lifecycle management.
"""

from __future__ import annotations

import atexit
from typing import TYPE_CHECKING

from kimi_cli.constant import VERSION
from kimi_cli.observability.config import ObservabilityConfig
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from opentelemetry.metrics import Meter
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.trace import Tracer

# Module-level state
_initialized: bool = False
_config: ObservabilityConfig | None = None
_tracer_provider: TracerProvider | None = None
_meter_provider: MeterProvider | None = None
_tracer: Tracer | None = None
_meter: Meter | None = None

SERVICE_NAME = "kimi-cli"


def is_initialized() -> bool:
    """Check if the observability SDK has been initialized."""
    return _initialized


def get_config() -> ObservabilityConfig | None:
    """Get the current observability configuration."""
    return _config


def initialize(config: ObservabilityConfig | None = None) -> bool:
    """
    Initialize the OpenTelemetry SDK with the given configuration.

    Args:
        config: Observability configuration. If None, uses default config.

    Returns:
        True if initialization succeeded, False otherwise.
    """
    global _initialized, _config, _tracer_provider, _meter_provider, _tracer, _meter

    if _initialized:
        logger.debug("Observability SDK already initialized")
        return True

    config = config or ObservabilityConfig.from_settings()
    _config = config

    if not config.is_effectively_enabled():
        logger.debug("Observability is disabled")
        _initialized = True
        return True

    try:
        _tracer_provider, _meter_provider, _tracer, _meter = _setup_sdk(config)
        _initialized = True
        atexit.register(shutdown)
        logger.info(
            "Observability SDK initialized with target={target}",
            target=config.export_target,
        )
        return True
    except ImportError as e:
        logger.warning(
            "OpenTelemetry packages not installed, observability disabled: {error}",
            error=e,
        )
        _initialized = True  # Mark as initialized to prevent repeated attempts
        return False
    except Exception as e:
        logger.error("Failed to initialize observability SDK: {error}", error=e)
        return False


def _setup_sdk(
    config: ObservabilityConfig,
) -> tuple[TracerProvider, MeterProvider, Tracer, Meter]:
    """Set up the OpenTelemetry SDK components."""
    from opentelemetry import metrics, trace
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.sampling import ParentBasedTraceIdRatio

    from kimi_cli.observability.exporters import create_metric_reader, create_span_processor

    # Create resource
    resource = Resource.create(
        {
            "service.name": SERVICE_NAME,
            "service.version": VERSION,
        }
    )

    sampler = ParentBasedTraceIdRatio(config.sampling_rate)

    span_processor = create_span_processor(config)

    tracer_provider = TracerProvider(
        resource=resource,
        sampler=sampler,
    )
    if span_processor is not None:
        tracer_provider.add_span_processor(span_processor)
    trace.set_tracer_provider(tracer_provider)

    metric_reader = create_metric_reader(config)
    if metric_reader is not None:
        meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    else:
        meter_provider = MeterProvider(resource=resource)
    metrics.set_meter_provider(meter_provider)

    tracer = trace.get_tracer(SERVICE_NAME, VERSION)
    meter = metrics.get_meter(SERVICE_NAME, VERSION)

    return tracer_provider, meter_provider, tracer, meter


def shutdown() -> None:
    """Shutdown the OpenTelemetry SDK and flush any pending data."""
    global _initialized, _tracer_provider, _meter_provider

    if not _initialized:
        return

    try:
        if _tracer_provider is not None:
            _tracer_provider.shutdown()
        if _meter_provider is not None:
            _meter_provider.shutdown()
        logger.debug("Observability SDK shutdown complete")
    except Exception as e:
        logger.error("Error during observability SDK shutdown: {error}", error=e)

    _initialized = False


def get_tracer() -> Tracer | None:
    """Get the global tracer instance."""
    return _tracer


def get_meter() -> Meter | None:
    """Get the global meter instance."""
    return _meter

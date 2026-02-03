"""
Observability module for Kimi CLI.
"""

from __future__ import annotations

from kimi_cli.observability.config import ObservabilityConfig, ObservabilitySettings
from kimi_cli.observability.metrics import (
    record_api_request,
    record_compaction,
    record_session_start,
    record_step,
    record_subagent_task,
    record_token_usage,
    record_tool_call,
    record_turn,
)
from kimi_cli.observability.sdk import get_config, initialize, is_initialized, shutdown
from kimi_cli.observability.trace import (
    add_span_event,
    get_current_span,
    set_span_attribute,
    trace_span,
    trace_span_async,
)

__all__ = [
    # SDK lifecycle
    "initialize",
    "shutdown",
    "is_initialized",
    "get_config",
    # Configuration
    "ObservabilityConfig",
    "ObservabilitySettings",
    # Tracing
    "trace_span",
    "trace_span_async",
    "get_current_span",
    "add_span_event",
    "set_span_attribute",
    # Metrics
    "record_session_start",
    "record_turn",
    "record_step",
    "record_tool_call",
    "record_api_request",
    "record_token_usage",
    "record_compaction",
    "record_subagent_task",
]

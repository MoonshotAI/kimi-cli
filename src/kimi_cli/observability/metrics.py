"""
Metrics recording for Kimi CLI.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from kimi_cli.observability.attributes import (
    CommonAttributes,
    CompactionAttributes,
    GenAIAttributes,
    SubagentAttributes,
    ToolAttributes,
    TurnAttributes,
)
from kimi_cli.observability.sdk import get_meter, is_initialized

if TYPE_CHECKING:
    from opentelemetry.metrics import Counter, Histogram

# Metric instances (lazily initialized)
_session_counter: Counter | None = None
_turn_counter: Counter | None = None
_turn_duration: Histogram | None = None
_step_counter: Counter | None = None
_tool_call_counter: Counter | None = None
_tool_call_duration: Histogram | None = None
_api_request_counter: Counter | None = None
_api_request_duration: Histogram | None = None
_token_usage_histogram: Histogram | None = None
_operation_duration_histogram: Histogram | None = None
_compaction_counter: Counter | None = None
_compaction_tokens_saved: Histogram | None = None
_subagent_task_counter: Counter | None = None
_subagent_task_duration: Histogram | None = None
_context_token_gauge: Histogram | None = None

_metrics_initialized: bool = False


def _ensure_metrics_initialized() -> bool:
    """Ensure metrics are initialized. Returns True if metrics are available."""
    global _metrics_initialized
    global _session_counter, _turn_counter, _turn_duration, _step_counter
    global _tool_call_counter, _tool_call_duration
    global _api_request_counter, _api_request_duration
    global _token_usage_histogram, _operation_duration_histogram
    global _compaction_counter, _compaction_tokens_saved
    global _subagent_task_counter, _subagent_task_duration
    global _context_token_gauge

    if _metrics_initialized:
        return get_meter() is not None

    if not is_initialized():
        return False

    meter = get_meter()
    if meter is None:
        _metrics_initialized = True
        return False

    # Session metrics
    _session_counter = meter.create_counter(
        name="kimi.session.count",
        description="Number of sessions started",
        unit="1",
    )

    # Turn metrics
    _turn_counter = meter.create_counter(
        name="kimi.turn.count",
        description="Number of turns executed",
        unit="1",
    )
    _turn_duration = meter.create_histogram(
        name="kimi.turn.duration",
        description="Turn execution duration",
        unit="ms",
    )

    # Step metrics
    _step_counter = meter.create_counter(
        name="kimi.step.count",
        description="Number of steps executed",
        unit="1",
    )

    # Tool metrics
    _tool_call_counter = meter.create_counter(
        name="kimi.tool.call.count",
        description="Number of tool calls",
        unit="1",
    )
    _tool_call_duration = meter.create_histogram(
        name="kimi.tool.call.duration",
        description="Tool call execution duration",
        unit="ms",
    )

    # API request metrics
    _api_request_counter = meter.create_counter(
        name="kimi.api.request.count",
        description="Number of LLM API requests",
        unit="1",
    )
    _api_request_duration = meter.create_histogram(
        name="kimi.api.request.duration",
        description="LLM API request duration",
        unit="ms",
    )

    # GenAI standard metrics
    _token_usage_histogram = meter.create_histogram(
        name="gen_ai.client.token.usage",
        description="Token usage by model and type",
        unit="token",
    )
    _operation_duration_histogram = meter.create_histogram(
        name="gen_ai.client.operation.duration",
        description="GenAI operation duration",
        unit="s",
    )

    # Compaction metrics
    _compaction_counter = meter.create_counter(
        name="kimi.compaction.count",
        description="Number of context compactions",
        unit="1",
    )
    _compaction_tokens_saved = meter.create_histogram(
        name="kimi.compaction.tokens_saved",
        description="Tokens saved by compaction",
        unit="token",
    )

    # Subagent metrics
    _subagent_task_counter = meter.create_counter(
        name="kimi.subagent.task.count",
        description="Number of subagent tasks",
        unit="1",
    )
    _subagent_task_duration = meter.create_histogram(
        name="kimi.subagent.task.duration",
        description="Subagent task duration",
        unit="ms",
    )

    # Context metrics
    _context_token_gauge = meter.create_histogram(
        name="kimi.context.token_count",
        description="Current context token count",
        unit="token",
    )

    _metrics_initialized = True
    return True


def record_session_start(
    *,
    session_id: str,
    agent_name: str,
) -> None:
    """Record a session start event."""
    if not _ensure_metrics_initialized() or _session_counter is None:
        return

    _session_counter.add(
        1,
        {
            CommonAttributes.SESSION_ID: session_id,
            CommonAttributes.AGENT_NAME: agent_name,
        },
    )


def record_turn(
    *,
    session_id: str,
    agent_name: str,
    outcome: Literal["no_tool_calls", "tool_rejected", "max_steps", "error"],
    step_count: int,
    duration_ms: float,
) -> None:
    """Record a turn completion."""
    if not _ensure_metrics_initialized():
        return

    attrs = {
        CommonAttributes.SESSION_ID: session_id,
        CommonAttributes.AGENT_NAME: agent_name,
        TurnAttributes.TURN_OUTCOME: outcome,
        TurnAttributes.TURN_STEP_COUNT: step_count,
    }

    if _turn_counter is not None:
        _turn_counter.add(1, attrs)

    if _turn_duration is not None:
        _turn_duration.record(duration_ms, attrs)


def record_step(
    *,
    session_id: str,
    agent_name: str,
    step_number: int,
) -> None:
    """Record a step execution."""
    if not _ensure_metrics_initialized() or _step_counter is None:
        return

    _step_counter.add(
        1,
        {
            CommonAttributes.SESSION_ID: session_id,
            CommonAttributes.AGENT_NAME: agent_name,
            CommonAttributes.STEP_NUMBER: step_number,
        },
    )


def record_tool_call(
    *,
    tool_name: str,
    tool_type: Literal["native", "mcp", "external"],
    success: bool,
    duration_ms: float,
    approval: Literal["approved", "rejected", "auto"] | None = None,
    session_id: str | None = None,
) -> None:
    """Record a tool call."""
    if not _ensure_metrics_initialized():
        return

    attrs: dict[str, str | bool] = {
        ToolAttributes.TOOL_NAME: tool_name,
        ToolAttributes.TOOL_TYPE: tool_type,
        ToolAttributes.TOOL_SUCCESS: success,
    }
    if approval is not None:
        attrs[ToolAttributes.TOOL_APPROVAL] = approval
    if session_id is not None:
        attrs[CommonAttributes.SESSION_ID] = session_id

    if _tool_call_counter is not None:
        _tool_call_counter.add(1, attrs)

    if _tool_call_duration is not None:
        duration_attrs = {
            ToolAttributes.TOOL_NAME: tool_name,
            ToolAttributes.TOOL_TYPE: tool_type,
        }
        _tool_call_duration.record(duration_ms, duration_attrs)


def record_api_request(
    *,
    model: str,
    system: str = "kimi",
    status_code: int | None = None,
    duration_ms: float | None = None,
    error_type: str | None = None,
) -> None:
    """Record an LLM API request."""
    if not _ensure_metrics_initialized():
        return

    attrs: dict[str, str | int] = {
        GenAIAttributes.SYSTEM: system,
        GenAIAttributes.REQUEST_MODEL: model,
    }
    if status_code is not None:
        attrs["status_code"] = status_code
    if error_type is not None:
        attrs["error_type"] = error_type

    if _api_request_counter is not None:
        _api_request_counter.add(1, attrs)

    if _api_request_duration is not None and duration_ms is not None:
        _api_request_duration.record(
            duration_ms,
            {
                GenAIAttributes.SYSTEM: system,
                GenAIAttributes.REQUEST_MODEL: model,
            },
        )


def record_token_usage(
    *,
    model: str,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    system: str = "kimi",
    operation: str = "chat",
    duration_s: float | None = None,
) -> None:
    """
    Record token usage following GenAI semantic conventions.

    Args:
        model: The model name.
        input_tokens: Number of input tokens.
        output_tokens: Number of output tokens.
        system: The GenAI system name.
        operation: The operation name.
        duration_s: Operation duration in seconds.
    """
    if not _ensure_metrics_initialized():
        return

    base_attrs = {
        GenAIAttributes.SYSTEM: system,
        GenAIAttributes.REQUEST_MODEL: model,
        GenAIAttributes.OPERATION_NAME: operation,
    }

    if _token_usage_histogram is not None:
        if input_tokens is not None:
            _token_usage_histogram.record(
                input_tokens,
                {**base_attrs, GenAIAttributes.TOKEN_TYPE: "input"},
            )
        if output_tokens is not None:
            _token_usage_histogram.record(
                output_tokens,
                {**base_attrs, GenAIAttributes.TOKEN_TYPE: "output"},
            )

    if _operation_duration_histogram is not None and duration_s is not None:
        _operation_duration_histogram.record(duration_s, base_attrs)


def record_compaction(
    *,
    agent_name: str,
    tokens_before: int,
    tokens_after: int,
    session_id: str | None = None,
) -> None:
    """Record a context compaction event."""
    if not _ensure_metrics_initialized():
        return

    attrs: dict[str, str | int] = {
        CommonAttributes.AGENT_NAME: agent_name,
        CompactionAttributes.TOKENS_BEFORE: tokens_before,
        CompactionAttributes.TOKENS_AFTER: tokens_after,
    }
    if session_id is not None:
        attrs[CommonAttributes.SESSION_ID] = session_id

    if _compaction_counter is not None:
        _compaction_counter.add(1, attrs)

    if _compaction_tokens_saved is not None:
        tokens_saved = tokens_before - tokens_after
        _compaction_tokens_saved.record(
            tokens_saved,
            {CommonAttributes.AGENT_NAME: agent_name},
        )


def record_subagent_task(
    *,
    agent_name: str,
    subagent_name: str,
    subagent_type: Literal["fixed", "dynamic"],
    duration_ms: float,
    session_id: str | None = None,
) -> None:
    """Record a subagent task execution."""
    if not _ensure_metrics_initialized():
        return

    attrs: dict[str, str] = {
        CommonAttributes.AGENT_NAME: agent_name,
        SubagentAttributes.SUBAGENT_NAME: subagent_name,
        SubagentAttributes.SUBAGENT_TYPE: subagent_type,
    }
    if session_id is not None:
        attrs[CommonAttributes.SESSION_ID] = session_id

    if _subagent_task_counter is not None:
        _subagent_task_counter.add(1, attrs)

    if _subagent_task_duration is not None:
        _subagent_task_duration.record(duration_ms, attrs)


def record_context_token_count(
    *,
    agent_name: str,
    token_count: int,
    session_id: str | None = None,
) -> None:
    """Record the current context token count."""
    if not _ensure_metrics_initialized() or _context_token_gauge is None:
        return

    attrs: dict[str, str | int] = {
        CommonAttributes.AGENT_NAME: agent_name,
    }
    if session_id is not None:
        attrs[CommonAttributes.SESSION_ID] = session_id

    _context_token_gauge.record(token_count, attrs)

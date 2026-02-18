"""
Attribute constants for OpenTelemetry spans and metrics.
"""

from __future__ import annotations


class CommonAttributes:
    """Common attributes for all telemetry data."""

    SESSION_ID = "session.id"
    TURN_ID = "turn.id"
    STEP_NUMBER = "step.number"
    AGENT_NAME = "agent.name"
    KIMI_VERSION = "kimi.version"


class GenAIAttributes:
    """
    GenAI semantic convention attributes.

    Reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/
    """

    # System and operation
    SYSTEM = "gen_ai.system"
    OPERATION_NAME = "gen_ai.operation.name"

    # Request attributes
    REQUEST_MODEL = "gen_ai.request.model"
    REQUEST_TEMPERATURE = "gen_ai.request.temperature"
    REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens"
    REQUEST_TOP_P = "gen_ai.request.top_p"

    # Response attributes
    RESPONSE_MODEL = "gen_ai.response.model"
    RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons"
    RESPONSE_ID = "gen_ai.response.id"

    # Token usage
    USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens"
    USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens"
    USAGE_TOTAL_TOKENS = "gen_ai.usage.total_tokens"

    # Token type for metrics
    TOKEN_TYPE = "gen_ai.token.type"

    # Prompt and completion content (optional, controlled by config)
    PROMPT = "gen_ai.prompt"
    COMPLETION = "gen_ai.completion"


class ToolAttributes:
    """Tool execution attributes."""

    TOOL_NAME = "tool.name"
    TOOL_TYPE = "tool.type"  # "native" | "mcp" | "external"
    TOOL_SUCCESS = "tool.success"
    TOOL_APPROVAL = "tool.approval"  # "approved" | "rejected" | "auto"
    TOOL_ERROR = "tool.error"
    TOOL_DURATION_MS = "tool.duration_ms"


class TurnAttributes:
    """Turn-level attributes."""

    TURN_OUTCOME = "turn.outcome"  # "no_tool_calls" | "tool_rejected" | "max_steps"
    TURN_STEP_COUNT = "turn.step_count"
    TURN_DURATION_MS = "turn.duration_ms"


class SubagentAttributes:
    """Subagent task attributes."""

    SUBAGENT_NAME = "subagent.name"
    SUBAGENT_TYPE = "subagent.type"  # "fixed" | "dynamic"


class CompactionAttributes:
    """Context compaction attributes."""

    TOKENS_BEFORE = "compaction.tokens_before"
    TOKENS_AFTER = "compaction.tokens_after"
    TOKENS_SAVED = "compaction.tokens_saved"


class ErrorAttributes:
    """Error-related attributes."""

    ERROR_TYPE = "error.type"
    ERROR_MESSAGE = "error.message"

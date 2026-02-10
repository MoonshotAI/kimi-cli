"""Tests for observability module."""

from __future__ import annotations

import os
from unittest import mock

import pytest

from kimi_cli.observability.config import ObservabilityConfig, ObservabilitySettings
from kimi_cli.observability.metrics import (
    record_api_request,
    record_compaction,
    record_context_token_count,
    record_session_start,
    record_step,
    record_subagent_task,
    record_token_usage,
    record_tool_call,
    record_turn,
)
from kimi_cli.observability.sdk import (
    get_config,
    get_meter,
    get_tracer,
    initialize,
    is_initialized,
    shutdown,
)
from kimi_cli.observability.trace import (
    NoOpSpan,
    get_current_span,
    set_span_attribute,
    set_span_attributes,
    trace_span,
    trace_span_async,
)


@pytest.fixture
def reset_sdk():
    """Reset SDK state before and after test."""
    import kimi_cli.observability.sdk as sdk

    # Save and reset state
    original = (
        sdk._initialized,
        sdk._config,
        sdk._tracer_provider,
        sdk._tracer,
        sdk._meter,
    )
    sdk._initialized = False
    sdk._config = None
    sdk._tracer_provider = None
    sdk._tracer = None
    sdk._meter = None

    yield

    # Restore state
    (
        sdk._initialized,
        sdk._config,
        sdk._tracer_provider,
        sdk._tracer,
        sdk._meter,
    ) = original


# =============================================================================
# Configuration Tests
# =============================================================================


class TestObservabilitySettings:
    """Tests for ObservabilitySettings dataclass."""

    def test_default_values(self):
        settings = ObservabilitySettings()
        assert settings.enabled is False
        assert settings.export_target == "none"
        assert settings.otlp_endpoint == "http://localhost:4317"
        assert settings.otlp_protocol == "grpc"
        assert settings.otlp_headers == {}
        assert settings.file_path == ""
        assert settings.sampling_rate == 1.0

    def test_custom_values(self):
        settings = ObservabilitySettings(
            enabled=True,
            export_target="otlp",
            otlp_endpoint="http://collector:4317",
            otlp_protocol="http",
            otlp_headers={"Authorization": "Bearer token"},
            file_path="/tmp/telemetry.jsonl",
            sampling_rate=0.5,
        )
        assert settings.enabled is True
        assert settings.export_target == "otlp"
        assert settings.otlp_endpoint == "http://collector:4317"


class TestObservabilityConfig:
    """Tests for ObservabilityConfig resolution."""

    def test_from_settings_defaults(self):
        config = ObservabilityConfig.from_settings()
        assert config.enabled is False
        assert config.export_target == "none"

    def test_from_settings_custom(self):
        settings = ObservabilitySettings(enabled=True, export_target="otlp")
        config = ObservabilityConfig.from_settings(settings)
        assert config.enabled is True
        assert config.export_target == "otlp"

    def test_env_override_enabled(self):
        settings = ObservabilitySettings(enabled=False)
        with mock.patch.dict(os.environ, {"KIMI_TELEMETRY_ENABLED": "true"}):
            config = ObservabilityConfig.from_settings(settings)
        assert config.enabled is True

    def test_env_override_disabled(self):
        settings = ObservabilitySettings(enabled=True)
        with mock.patch.dict(os.environ, {"KIMI_TELEMETRY_ENABLED": "false"}):
            config = ObservabilityConfig.from_settings(settings)
        assert config.enabled is False

    def test_env_override_export_target(self):
        with mock.patch.dict(os.environ, {"KIMI_TELEMETRY_EXPORT_TARGET": "console"}):
            config = ObservabilityConfig.from_settings()
        assert config.export_target == "console"

    def test_env_override_otlp_endpoint(self):
        with mock.patch.dict(os.environ, {"KIMI_TELEMETRY_OTLP_ENDPOINT": "http://env:4317"}):
            config = ObservabilityConfig.from_settings()
        assert config.otlp_endpoint == "http://env:4317"

    def test_env_override_sampling_rate(self):
        with mock.patch.dict(os.environ, {"KIMI_TELEMETRY_SAMPLING_RATE": "0.5"}):
            config = ObservabilityConfig.from_settings()
        assert config.sampling_rate == 0.5

    def test_sampling_rate_clamped(self):
        with mock.patch.dict(os.environ, {"KIMI_TELEMETRY_SAMPLING_RATE": "-0.5"}):
            config = ObservabilityConfig.from_settings()
        assert config.sampling_rate == 0.0

        with mock.patch.dict(os.environ, {"KIMI_TELEMETRY_SAMPLING_RATE": "1.5"}):
            config = ObservabilityConfig.from_settings()
        assert config.sampling_rate == 1.0

    def test_cli_override(self):
        settings = ObservabilitySettings(enabled=False)
        config = ObservabilityConfig.from_settings(settings, cli_enabled=True)
        assert config.enabled is True

    def test_cli_overrides_env(self):
        with mock.patch.dict(os.environ, {"KIMI_TELEMETRY_ENABLED": "true"}):
            config = ObservabilityConfig.from_settings(cli_enabled=False)
        assert config.enabled is False

    def test_otlp_headers_from_env(self):
        with mock.patch.dict(
            os.environ, {"KIMI_TELEMETRY_OTLP_HEADERS": "key1=value1,key2=value2"}
        ):
            config = ObservabilityConfig.from_settings()
        assert config.otlp_headers == {"key1": "value1", "key2": "value2"}

    def test_is_effectively_enabled(self):
        config1 = ObservabilityConfig.from_settings(
            ObservabilitySettings(enabled=False, export_target="otlp")
        )
        assert config1.is_effectively_enabled() is False

        config2 = ObservabilityConfig.from_settings(
            ObservabilitySettings(enabled=True, export_target="none")
        )
        assert config2.is_effectively_enabled() is False

        config3 = ObservabilityConfig.from_settings(
            ObservabilitySettings(enabled=True, export_target="otlp")
        )
        assert config3.is_effectively_enabled() is True


# =============================================================================
# SDK Lifecycle Tests
# =============================================================================


class TestSDKLifecycle:
    """Tests for SDK initialization and shutdown."""

    def setup_method(self):
        import kimi_cli.observability.sdk as sdk

        sdk._initialized = False
        sdk._config = None
        sdk._tracer_provider = None
        sdk._tracer = None
        sdk._meter = None

    def test_is_initialized_false_initially(self):
        assert is_initialized() is False

    def test_initialize_with_disabled_config(self):
        config = ObservabilityConfig.from_settings(ObservabilitySettings(enabled=False))
        assert initialize(config) is True
        assert is_initialized() is True
        assert get_tracer() is None
        assert get_meter() is None

    def test_initialize_with_none_target(self):
        config = ObservabilityConfig.from_settings(
            ObservabilitySettings(enabled=True, export_target="none")
        )
        assert initialize(config) is True

    def test_get_config_before_init(self):
        assert get_config() is None

    def test_get_config_after_init(self):
        config = ObservabilityConfig.from_settings()
        initialize(config)
        assert get_config() == config

    def test_initialize_idempotent(self):
        config1 = ObservabilityConfig.from_settings(ObservabilitySettings(enabled=False))
        config2 = ObservabilityConfig.from_settings(
            ObservabilitySettings(enabled=True, export_target="console")
        )
        initialize(config1)
        initialize(config2)
        assert get_config() == config1  # First wins

    def test_shutdown_before_init(self):
        shutdown()  # Should not raise

    def test_shutdown_after_init(self):
        initialize(ObservabilityConfig.from_settings())
        shutdown()
        assert is_initialized() is False


class TestSDKWithConsoleExporter:
    """Tests for SDK with console exporter."""

    def setup_method(self):
        import kimi_cli.observability.sdk as sdk

        sdk._initialized = False
        sdk._config = None
        sdk._tracer_provider = None
        sdk._tracer = None
        sdk._meter = None

    def teardown_method(self):
        shutdown()

    def test_initialize_console_exporter(self):
        pytest.importorskip("opentelemetry.sdk")
        config = ObservabilityConfig.from_settings(
            ObservabilitySettings(enabled=True, export_target="console")
        )
        assert initialize(config) is True
        assert get_tracer() is not None
        assert get_meter() is not None

    def test_tracer_creates_spans(self):
        pytest.importorskip("opentelemetry.sdk")
        config = ObservabilityConfig.from_settings(
            ObservabilitySettings(enabled=True, export_target="console")
        )
        initialize(config)
        tracer = get_tracer()
        assert tracer is not None
        with tracer.start_as_current_span("test_span") as span:
            span.set_attribute("key", "value")

    def test_meter_creates_instruments(self):
        pytest.importorskip("opentelemetry.sdk")
        config = ObservabilityConfig.from_settings(
            ObservabilitySettings(enabled=True, export_target="console")
        )
        initialize(config)
        meter = get_meter()
        assert meter is not None
        counter = meter.create_counter("test_counter")
        counter.add(1, {"key": "value"})


# =============================================================================
# Tracing Tests
# =============================================================================


class TestNoOpSpan:
    """Tests for NoOpSpan class."""

    def test_set_attribute(self):
        span = NoOpSpan()
        span.set_attribute("key", "value")

    def test_set_attributes(self):
        span = NoOpSpan()
        span.set_attributes({"key1": "value1", "key2": "value2"})

    def test_add_event(self):
        span = NoOpSpan()
        span.add_event("event_name", {"attr": "value"})

    def test_record_exception(self):
        span = NoOpSpan()
        span.record_exception(ValueError("test"))

    def test_is_recording(self):
        span = NoOpSpan()
        assert span.is_recording() is False


class TestTraceSpanUninitialized:
    """Tests for trace_span when SDK is not initialized."""

    @pytest.fixture(autouse=True)
    def reset_sdk_state(self):
        import kimi_cli.observability.sdk as sdk

        original = (
            sdk._initialized,
            sdk._config,
            sdk._tracer_provider,
            sdk._tracer,
            sdk._meter,
        )
        sdk._initialized = False
        sdk._config = None
        sdk._tracer_provider = None
        sdk._tracer = None
        sdk._meter = None
        yield
        (
            sdk._initialized,
            sdk._config,
            sdk._tracer_provider,
            sdk._tracer,
            sdk._meter,
        ) = original

    def test_trace_span_returns_noop(self):
        with trace_span("test_span") as span:
            assert isinstance(span, NoOpSpan)

    def test_get_current_span_returns_noop(self):
        assert isinstance(get_current_span(), NoOpSpan)

    def test_set_span_attribute_no_error(self):
        set_span_attribute("key", "value")

    def test_set_span_attributes_no_error(self):
        set_span_attributes({"key1": "value1", "key2": 123})

    def test_nested_trace_spans(self):
        with trace_span("outer") as outer:
            assert isinstance(outer, NoOpSpan)
            with trace_span("inner") as inner:
                assert isinstance(inner, NoOpSpan)

    def test_trace_span_exception_propagates(self):
        with pytest.raises(ValueError, match="test error"), trace_span("test"):
            raise ValueError("test error")


# =============================================================================
# Metrics Tests
# =============================================================================


class TestMetricsUninitialized:
    """Tests for metrics recording when SDK is not initialized."""

    def test_record_session_start(self):
        record_session_start(session_id="test-session", agent_name="test-agent")

    def test_record_turn(self):
        record_turn(
            session_id="test-session",
            agent_name="test-agent",
            outcome="no_tool_calls",
            step_count=5,
            duration_ms=1000.0,
        )

    def test_record_step(self):
        record_step(session_id="test-session", agent_name="test-agent", step_number=1)

    def test_record_tool_call(self):
        record_tool_call(
            tool_name="Shell",
            tool_type="native",
            success=True,
            duration_ms=500.0,
            approval="approved",
        )

    def test_record_tool_call_types(self):
        record_tool_call(tool_name="mcp_tool", tool_type="mcp", success=False, duration_ms=100.0)
        record_tool_call(
            tool_name="external_tool", tool_type="external", success=True, duration_ms=200.0
        )

    def test_record_api_request(self):
        record_api_request(model="kimi-code", system="kimi", status_code=200, duration_ms=1500.0)

    def test_record_api_request_with_error(self):
        record_api_request(model="kimi-code", status_code=500, error_type="internal_error")

    def test_record_token_usage(self):
        record_token_usage(
            model="kimi-code",
            input_tokens=100,
            output_tokens=200,
            system="kimi",
            operation="chat",
        )

    def test_record_compaction(self):
        record_compaction(agent_name="test-agent", tokens_before=50000, tokens_after=10000)

    def test_record_subagent_task(self):
        record_subagent_task(
            agent_name="main-agent",
            subagent_name="coder",
            subagent_type="fixed",
            duration_ms=5000.0,
        )

    def test_record_context_token_count(self):
        record_context_token_count(agent_name="test-agent", token_count=15000)


# =============================================================================
# Async Tracing Tests
# =============================================================================


class TestTraceSpanAsync:
    """Tests for async trace_span_async."""

    @pytest.fixture(autouse=True)
    def reset_sdk_state(self):
        import kimi_cli.observability.sdk as sdk

        original = (
            sdk._initialized,
            sdk._config,
            sdk._tracer_provider,
            sdk._tracer,
            sdk._meter,
        )
        sdk._initialized = False
        sdk._config = None
        sdk._tracer_provider = None
        sdk._tracer = None
        sdk._meter = None
        yield
        (
            sdk._initialized,
            sdk._config,
            sdk._tracer_provider,
            sdk._tracer,
            sdk._meter,
        ) = original

    async def test_trace_span_async_returns_noop(self):
        async with trace_span_async("test_span") as span:
            assert isinstance(span, NoOpSpan)

    async def test_trace_span_async_with_attributes(self):
        async with trace_span_async("test", attributes={"key": "value"}) as span:
            span.set_attribute("result", "success")
            assert isinstance(span, NoOpSpan)

    async def test_trace_span_async_nested(self):
        async with trace_span_async("outer") as outer:
            assert isinstance(outer, NoOpSpan)
            async with trace_span_async("inner") as inner:
                assert isinstance(inner, NoOpSpan)

    async def test_trace_span_async_exception_propagates(self):
        with pytest.raises(ValueError, match="async error"):
            async with trace_span_async("test"):
                raise ValueError("async error")


# =============================================================================
# Attribute Constants Tests
# =============================================================================


class TestAttributes:
    """Tests for attribute constants."""

    def test_common_attributes(self):
        from kimi_cli.observability.attributes import CommonAttributes

        assert CommonAttributes.SESSION_ID == "session.id"
        assert CommonAttributes.AGENT_NAME == "agent.name"
        assert CommonAttributes.STEP_NUMBER == "step.number"

    def test_genai_attributes(self):
        from kimi_cli.observability.attributes import GenAIAttributes

        assert GenAIAttributes.SYSTEM == "gen_ai.system"
        assert GenAIAttributes.REQUEST_MODEL == "gen_ai.request.model"
        assert GenAIAttributes.TOKEN_TYPE == "gen_ai.token.type"
        assert GenAIAttributes.PROMPT == "gen_ai.prompt"
        assert GenAIAttributes.COMPLETION == "gen_ai.completion"

    def test_tool_attributes(self):
        from kimi_cli.observability.attributes import ToolAttributes

        assert ToolAttributes.TOOL_NAME == "tool.name"
        assert ToolAttributes.TOOL_TYPE == "tool.type"
        assert ToolAttributes.TOOL_SUCCESS == "tool.success"

    def test_turn_attributes(self):
        from kimi_cli.observability.attributes import TurnAttributes

        assert TurnAttributes.TURN_OUTCOME == "turn.outcome"
        assert TurnAttributes.TURN_STEP_COUNT == "turn.step_count"

    def test_subagent_attributes(self):
        from kimi_cli.observability.attributes import SubagentAttributes

        assert SubagentAttributes.SUBAGENT_NAME == "subagent.name"
        assert SubagentAttributes.SUBAGENT_TYPE == "subagent.type"

    def test_compaction_attributes(self):
        from kimi_cli.observability.attributes import CompactionAttributes

        assert CompactionAttributes.TOKENS_BEFORE == "compaction.tokens_before"
        assert CompactionAttributes.TOKENS_AFTER == "compaction.tokens_after"

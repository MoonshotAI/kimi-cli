# Observability Module

OpenTelemetry-based tracing and metrics for Kimi CLI.

## Installation

```bash
uv sync --extra observability
```

## Configuration

### Config File (`~/.kimi/config.toml`)

```toml
[observability]
enabled = true
export_target = "otlp"  # console | otlp | file | none
otlp_endpoint = "http://localhost:4317"
otlp_protocol = "grpc"  # grpc | http
sampling_rate = 1.0
log_content = false     # Log prompts and responses as span attributes
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `KIMI_TELEMETRY_ENABLED` | Enable observability | `false` |
| `KIMI_TELEMETRY_EXPORT_TARGET` | Export target | `none` |
| `KIMI_TELEMETRY_OTLP_ENDPOINT` | OTLP endpoint | `http://localhost:4317` |
| `KIMI_TELEMETRY_OTLP_PROTOCOL` | OTLP protocol | `grpc` |
| `KIMI_TELEMETRY_OTLP_HEADERS` | Headers (k1=v1,k2=v2) | - |
| `KIMI_TELEMETRY_SAMPLING_RATE` | Sampling rate (0.0-1.0) | `1.0` |
| `KIMI_TELEMETRY_LOG_CONTENT` | Log prompts and responses | `false` |

### Priority

CLI args > Environment variables > Config file

## Export Targets

| Target | Description |
|--------|-------------|
| `console` | Print to stdout (debug) |
| `otlp` | Send to OTLP collector (Jaeger/Grafana) |
| `file` | Write to `~/.kimi/telemetry/*.jsonl` |
| `none` | Disabled |

## Instrumentation Points

The following code paths are instrumented:

### Tracing Spans

| Span Name | Location | Description |
|-----------|----------|-------------|
| `kimi.turn` | `KimiSoul._turn()` | One user turn (prompt to response) |
| `kimi.step` | `KimiSoul._agent_loop()` | Single LLM + tool execution step |
| `kimi.llm.call` | `KimiSoul._step()` | LLM API call |
| `kimi.tool.call` | `KimiToolset.handle()` | Tool execution |
| `kimi.compaction` | `KimiSoul.compact_context()` | Context compaction |
| `kimi.subagent.task` | `Task.__call__()` | Subagent task execution |

### LLM Call Span Attributes

The `kimi.llm.call` span includes the following attributes:

| Attribute | Description | Condition |
|-----------|-------------|-----------|
| `gen_ai.system` | System identifier ("kimi") | Always |
| `gen_ai.request.model` | Model name | Always |
| `gen_ai.operation.name` | Operation type ("chat") | Always |
| `gen_ai.usage.input_tokens` | Input token count | When available |
| `gen_ai.usage.output_tokens` | Output token count | When available |
| `gen_ai.usage.total_tokens` | Total token count | When available |
| `gen_ai.prompt` | User prompt content | When `log_content = true` |
| `gen_ai.completion` | LLM response content | When `log_content = true` |

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `kimi.session.count` | Counter | Sessions started |
| `kimi.turn.count` | Counter | Turns executed |
| `kimi.turn.duration` | Histogram | Turn duration (ms) |
| `kimi.step.count` | Counter | Steps executed |
| `kimi.tool.call.count` | Counter | Tool calls |
| `kimi.tool.call.duration` | Histogram | Tool duration (ms) |
| `kimi.api.request.count` | Counter | LLM API requests |
| `kimi.api.request.duration` | Histogram | API duration (ms) |
| `gen_ai.client.token.usage` | Histogram | Token usage (GenAI convention) |
| `gen_ai.client.operation.duration` | Histogram | Operation duration (s) |
| `kimi.compaction.count` | Counter | Context compactions |
| `kimi.compaction.tokens_saved` | Histogram | Tokens saved by compaction |
| `kimi.subagent.task.count` | Counter | Subagent tasks |
| `kimi.subagent.task.duration` | Histogram | Subagent task duration (ms) |
| `kimi.context.token_count` | Histogram | Context token count |
